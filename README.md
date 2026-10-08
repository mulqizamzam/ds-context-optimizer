# dsh-context-optimizer

Plugin untuk [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) yang
memberi agent empat belas tool bernama `ctx_*`. Tujuannya satu: menjaga jendela konteks (context
window) tetap berisi informasi yang berguna, bukan tumpukan output mentah.

Kalau agent menjalankan `cat data.json` pada berkas 3 MB, 3 MB itu masuk permanen ke percakapan
walaupun model hanya butuh tiga baris. Plugin ini menyediakan jalan lain: jalankan perintahnya,
simpan output-nya ke indeks pencarian lokal (SQLite), lalu kembalikan hanya potongan yang cocok
dengan pertanyaan yang diajukan. Data besar seperti itu tidak lagi memenuhi context window.

Fitur kedua: plugin mencatat kejadian tiap sesi ke SQLite. Saat jendela konteks dikompresi atau
sesi dilanjutkan, keadaan sebelumnya disuntikkan kembali sebagai blok `<session_snapshot>`
yang ringkas saat prompt dirakit.

**Status: eksperimental.** Plugin ini tidak aktif di profil mana pun secara bawaan, karena blok
`config:` di `cordis.patch.yml` sengaja dikomentari. Setiap angka di dokumen ini diukur pada
satu mesin acuan (Linux, Node v24.19.0, bubblewrap 0.11.1) pada 2026-10-07, dan ditandai
begitu agar tidak terbaca sebagai jaminan untuk mesin Anda.

> **Baru pertama kali memasang plugin DSH?** Lewati ke [Bagian 3](#3-installation-dari-komputer-kosong).
> Bagian 4 sampai 16 adalah referensi, bisa dibaca nanti.
>
> **Pemula yang juga belum tahu apa itu DSH?** Baca [Bagian 1.4](#14-lima-istilah-yang-harus-dipahami-dulu).

---

## Daftar Isi

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Installation (dari komputer kosong)](#3-installation-dari-komputer-kosong)
4. [Configuration](#4-configuration)
5. [Database dan layanan eksternal](#5-database-dan-layanan-eksternal)
6. [Menjalankan project](#6-menjalankan-project)
7. [First use / Quick start](#7-first-use--quick-start)
8. [Project structure](#8-project-structure)
9. [Common commands](#9-common-commands)
10. [Testing](#10-testing)
11. [Troubleshooting](#11-troubleshooting)
12. [Development guide](#12-development-guide)
13. [Deployment](#13-deployment)
14. [Security notes](#14-security-notes)
15. [FAQ](#15-faq)
16. [Final checklist](#16-final-checklist)

Lampiran: [Known issues dari audit](#known-issues-dari-audit-e2e-dan-source-review)

---

# 1. Overview

## 1.1 Apa ini

Ini **paket plugin untuk DSH**, bukan aplikasi web, bukan layanan, bukan CLI mandiri.

DSH memuat plugin dari sebuah *profil*. Saat profil berjalan, plugin ini mendaftarkan sepuluh
tool ke daftar tool host, lalu model dapat memanggilnya seperti memanggil `bash` atau `read`.
Tidak ada proses tambahan yang harus dijalankan, tidak ada port yang dibuka, tidak ada server
yang harus dijaga hidup.

Secara ringkas:

| Pertanyaan | Jawaban |
| --- | --- |
| Ini aplikasi web? | Tidak |
| Ada HTTP API? | Tidak |
| Perlu Docker? | Tidak |
| Perlu `.env`? | Tidak, repo ini memang tidak punya berkas `.env` |
| Perlu API key / akun berbayar? | Tidak |
| Perlu database server? | Tidak, hanya dua berkas SQLite lokal |
| Yang harus dijalankan manual? | Hanya DSH-nya (`dsh web`), plugin ikut termuat saat profil boot |

## 1.2 Masalah yang diselesaikan

| Masalah | Mekanisme | Berkas sumber |
| --- | --- | --- |
| Output perintah membanjiri konteks | Jalankan di subprocess terkurung, indeks output ke SQLite, kembalikan hanya potongan ber-ranking | `src/executor.ts`, `src/store.ts` |
| Sesi kehilangan Ingatan | Rekam `session/event` ke SQLite, bangun ulang snapshot XML berbatas, suntik saat prompt dirakit | `src/session/db.ts`, `src/session/snapshot.ts` |

Tidak ada data yang diunggah ke mana pun. Indeks dan log sesi adalah dua berkas SQLite di
direktori yang Anda tentukan.

## 1.3 Use case utama

- **Audit repo besar.** Indeks `src/` sekali, lalu cari istilah berulang kali tanpa memuat
  isi berkas ke konteks.
- **Log besar.** `grep` pada berkas log 200 MB diganti dengan pencarian terindeks yang
  mengembalikan cuplikan 240 karakter per hasil.
- **Riset web.** Ambil satu URL, indeks teksnya, cari bagian yang relevan, bawa ringkasannya
  ke percakapan.
- **Sesi panjang.** Kontinuitas antar giliran: keputusan dan file yang sedang dikerjakan
  muncul lagi saat konteks dikompresi.
- **Eksekusi terisolasi.** Menjalankan satu program (12 bahasa) dengan batas ukuran output,
  batas waktu, dan batas file yang bisa ditulis.

Yang **bukan** tujuan plugin ini: mempercepat perintah. Plugin ini mengurangi apa yang masuk
ke jendela konteks, bukan mempercepat(kernel) apa pun.

## 1.4 Lima istilah yang harus dipahami dulu

**1. Profil (profile).**
DSH menyusun seluruh instalasi ke dalam profil, umumnya di
`$DSH_HOME/profiles/<nama>/`. Setiap profil punya `package.json`, `node_modules`, dan
`cordis.patch.yml` sendiri. Plugin dipasang **ke dalam profil**, bukan ke DSH secara global.
Pada mesin acuan, profil GUI bernama `web` berada di
`/home/administrator/agent-workspace/.dsh/profiles/web/`.

**2. Bundle patch.**
Plugin dapat membawa berkas YAML yang berisi "sisipkan konfigurasi ini". Saat boot, host
menggabungkan patch profil dengan patch setiap plugin terpasang menjadi satu pohon
konfigurasi. Berkas patch plugin ini adalah `cordis.patch.yml`, ditunjuk dari `package.json`:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

**3. Tool.**
Tool adalah fungsi bernama yang bisa dipanggil model, lengkap dengan skema JSON untuk
argumennya. Plugin ini mendaftarkan empat belas tool, semuanya berawalan `ctx_` secara bawaan.
Tool ini muncul di daftar tool yang sama dengan `bash`, `read`, dan tool bawaan host
lainnya. Panggilannya dilakukan oleh model, bukan oleh Anda lewat terminal.

**4. Direktori state.**
Tempat plugin menyimpan datanya. Bawaan: `$DSH_HOME/dsh-context-optimizer/`, dengan
cadangan `$HOME/.dsh/dsh-context-optimizer/` bila `DSH_HOME` tidak di-set. Isinya tepat dua
berkas: `index.sqlite` (indeks pencarian) dan `sessions.sqlite` (log kejadian dan snapshot),
ditambah berkas samping SQLite `-wal` dan `-shm`.

**5. Sandbox provider.**
Layanan milik host yang membungkus command line sehingga proses hasilnya tidak bisa menulis
di luar workspace. Plugin ini tidak %),mj Henancrementimplementasinya sendiri, dia meminta
layanan itu ke host. Kalau host tidak punya, tool eksekusi kode **menolak**, bukan melepas
batasnya.

## 1.5 Fitur utama (empat belas tool)

Semua nama mengikuti awalan `toolPrefix`, bawaannya `ctx_`.

| Tool | Gunanya | Menjalankan kode? |
| --- | --- | --- |
| `ctx_execute` | Jalankan satu program di subprocess terkurung, kembalikan stdout/stderr/exit code berbatas | Ya |
| `ctx_execute_file` | Sama seperti di atas, tapi satu berkas proyek tersedia sebagai env `TARGET_FILE` | Ya |
| `ctx_batch_execute` | Jalankan beberapa perintah shell paralel, indeks semua output, kembalikan cuplikan per query | Tidak langsung |
| `ctx_index` | Indeks berkas atau direktori ke penyimpanan full-text persisten | Tidak |
| `ctx_search` | Cari korpus terindeks, kembalikan cuplikan bertanda plus provenance, skor kualitas, dan kontradiksi | Tidak |
| `ctx_fetch_and_index` | Ambil satu URL, indeks teksnya, kembalikan ringkasan + hasil query | Tidak |
| `ctx_expand` | Perluas satu evidence id atau satu source jadi payload berlipat (L0 metadata ... L4 mentah) | Tidak |
| `ctx_gc` | Laporkan atau terapkan kebijakan retensi: apa yang bisa diambil kembali, apa yang dilindungi | Tidak |
| `ctx_diff` | Bedakan dua snapshot sesi, dua evidence, atau dua versi terindeks satu source | Tidak |
| `ctx_related` | Telusuri graf relasi dari satu entity dengan batas kedalaman dan jumlah node | Tidak |
| `ctx_resume` | Bangun ulang snapshot sesi dan kembalikan isinya | Tidak |
| `ctx_stats` | Laporan isi kedua store, cache, relasi, anggaran, dan data yang bisa di-GC | Tidak |
| `ctx_doctor` | Cek mandiri: sandbox, 12 runtime bahasa, versi skema, cache, relasi, seluruh error | Tidak |
| `ctx_purge` | Kosongkan indeks, log sesi, atau keduanya (butuh `confirm: true`) | Tidak |

Sepuluh tool pertama sudah ada sebelum infrastruktur konteks ditambahkan; empat terakhir ada
karena retrieval menjadi sesuatu yang bisa **diperluas**, **dibersihkan**, **dibedakan**, dan
**ditelusuri**, bukan hanya ditanya.

---

# 2. Prerequisites

## 2.1 Yang wajib ada

| Kebutuhan | Untuk apa | Sumber | Cara cek |
| --- | --- | --- | --- |
| Node.js `>=22.13` | build, test, jalankan | `package.json` → `engines.node` | `node --version` |
| npm | build dan test | ikut Node.js | `npm --version` |
| git | clone repo | sistem operasi | `git --version` |
| DSH CLI | menjalankan host, memasang plugin | terpasang terpisah | `dsh --version` |
| Satu profil DSH | **hanya** untuk menjalankan plugin | `$DSH_HOME/profiles/<nama>/` | `ls "$DSH_HOME/profiles"` |
| pnpm | **hanya** untuk `dsh plugin ... add` | DSH CLI meneruskan ke pnpm | `pnpm --version` |
| checkout DSH | **hanya** untuk `npm run test:host` | `DSH_HARNESS_HOME` | `ls "$DSH_HOME/../deepseek-harness"` atau lihat 2.4 |
| `bwrap` (bubblewrap) | **hanya** untuk `ctx_execute` benar-benar menjalankan kode | backend sandbox host | `bwrap --version` |

Tidak ada **runtime dependency**. Lapisan penyimpanan memakai `node:sqlite`, yang sudah
menyatu di Node, jadi tidak ada addon native yang harus dikompilasi.

Dev dependency, diambil dari `package.json`:

| Paket | Rentang | Untuk apa |
| --- | --- | --- |
| `typescript` | `^5.5.0` | mengompilasi `src/` ke `dist/` |
| `@types/node` | `^24.0.0` | definisi tipe |
| `yaml` | `^2.9.0` | test yang mem-parse `cordis.patch.yml` dengan parser yang sama dengan host |

## 2.2 Cek semuanya sekaligus

Salin blok ini untuk melihat kesiapan mesin dalam sekali jalan:

```bash
echo "node=$(node -v 2>&1)"
echo "npm=$(npm -v 2>&1)"
echo "pnpm=$(pnpm -v 2>&1)"
echo "git=$(git --version 2>&1)"
echo "dsh=$(dsh --version 2>&1)"
echo "bwrap=$(bwrap --version 2>&1)"
echo "DSH_HOME=$DSH_HOME"
ls "$DSH_HOME/profiles" 2>&1
```

Hasil yang terukur pada mesin acuan (2026-10-07):

```text
node=v24.19.0
npm=11.17.0
pnpm=11.7.0
git=git version 2.53.0
dsh=0.1.1-rc.2
bwrap=bubblewrap 0.11.1
DSH_HOME=/home/administrator/agent-workspace/.dsh
evo-live  headless  monid-release-test.disabled  monid.disabled  nk.disabled  node_modules  web
```

Node harus **v22.13 atau lebih baru**. Angka di bawah itu ditolak oleh `engines` dan bisa
gagal saat memakai API SQLite.

## 2.3 Runtime bahasa (opsional, per bahasa)

Anda **tidak** perlu memasang runtime untuk semua bahasa. Tabel ini hanya untuk yang memang
akan Anda panggil.

| Bahasa | Program | Argumen tetap | Status di mesin acuan |
| --- | --- | --- | --- |
| `javascript` | `node` | `--input-type=module` | tersedia |
| `typescript` | `node` | `--input-type=module-typescript` | tersedia |
| `python` | `python3` | `-u -` | tersedia |
| `bash` | `bash` | `-s` | tersedia |
| `ruby` | `ruby` | `-` | tidak ada |
| `php` | `php` | `-` | tidak ada |
| `perl` | `perl` | `-` | tersedia |
| `r` | `Rscript` | `-` | tidak ada |
| `lua` | `lua` | `-` | tidak ada |
| `go` | `go` | `run -` | tidak ada |
| `rust` | `rust-script` | `-` | tidak ada |
| `deno` | `deno` | `run --ext ts -` | tidak ada |

Tanda `-` atau `-s` di akhir itu penting: kode Anda **selalu dikirim lewat stdin**, tidak
pernah sebagai argumen command line. Alasannya, program yang muncul sebagai argumen akan
terlihat di keluaran `ps` untuk semua user lain di mesin, dan `sh -c` akan mencampurkan
metakarakter program Anda ke dalam tata bahasa shell.

`ctx_doctor` mengecek ulang tabel ini kapan pun Anda butuh (lihat [Bagian 7](#7-first-use--quick-start)).

## 2.4 Memasang bubblewrap

`ctx_execute` memakai layanan sandbox milik host. Pada mesin acuan, backend itu bubblewrap 0.11.1.
Pasang sesuai distribusi Anda:

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y bubblewrap

# Fedora
sudo dnf install -y bubblewrap

# Arch
sudo pacman -S bubblewrap
```

Kalau `bwrap --version` gagal, `ctx_doctor` akan melaporkan `sandbox.available: false` dan
`ctx_execute` menolak menjalankan apa pun. Itu perilaku yang benar: lebih baik menolak
daripada menjalankan kode tanpa batas.

**Perlu dikonfirmasi:** paket ini hanya diukur di Linux dengan bubblewrap. Perilaku pada
macOS atau Windows (misalnya lewat WSL) tidak diuji di repository ini, dan host DSH Anda
yang menentukan backend sandbox-nya, bukan plugin ini.

---

# 3. Installation (dari komputer kosong)

Bagian ini mengasumsikan Anda mulai dari mesin yang belum punya apa pun dari repo ini.
Ganti `ds-context-optimizer` dengan nama folder pilihan Anda kalau perlu.

## Langkah 1 — Ambil kodenya

```bash
git clone https://github.com/mulqizamzam/ds-context-optimizer.git
```

Kalau repo ini sudah ada di komputer Anda, lewati ke Langkah 2.

## Langkah 2 — Masuk ke folder project

```bash
cd ds-context-optimizer
```

**Kenapa:** semua perintah berikutnya (`npm install`, `npm test`) memakai path relatif ke folder
ini. Salah folder akan membuat `npm` meng-error atau tidak menemukan `package.json`.

Cek you're sudah di tempat yang benar:

```bash
ls package.json src test
```

Harus ada `package.json`, folder `src`, dan folder `test`.

## Langkah 3 — Pasang dependency

```bash
npm install
```

Kalau gagal dengan pesan `EROFS` yang menyebut `~/.npm`, itu tanda folder home Anda read-only
(kasus umum di dalam sandbox agent DSH). Arahkan cache ke dalam project saja:

```bash
npm install --cache ./.npm-cache
```

`.npm-cache/` sudah ada di `.gitignore`, jadi tidak akan ikut ter-commit.

Hanya ada empat paket yang dipasang, jadi ini selesai dalam hitungan detik.

## Langkah 4 — Build dan jalankan test

```bash
npm run build     # kompilasi src/ ke dist/
npm test          # build lagi, lalu jalankan suite unit dan host
```

`npm test` selalu menjalankan build lebih dulu, jadi satu perintah `npm test` sudah merupakan
verifikasi lengkap. Kalau hanya ingin memeriksa tipe tanpa menulis berkas:

```bash
npm run typecheck
```

Hasil terukur pada mesin acuan (2026-10-07): `npm run typecheck` keluar 0 tanpa diagnostik,
`npm run build` menulis 26 berkas ke `dist/`, dan `npm test` melaporkan 176 test dengan 175 lulus,
0 gagal, 1 dilewati, keluar 0.

**Kenapa langkah ini wajib:** `dist/` adalah yang benar-benar dimuat host lewat
`package.json` → `"main": "dist/index.js"`. Tanpa build, plugin terpasang tapi tidak punya
berkas untuk dijalankan.

## Langkah 5 — Tentukan profil tujuan

Plugin dipasang **ke dalam profil**. Perintah `dsh plugin --profile <nama>` akan membuat folder
profil bila belum ada, diinisialisasi dari template DSH.

Gunakan `web` kalau ingin tool-nya muncul di GUI browser. Gunakan nama profil lain yang sudah
Anda miliki kalau mau di tempat lain.

Sebelum memasang, ingat satu hal: plugin ini **menambah tool yang bisa dipanggil model**, dan
salah satunya (`ctx_execute`) menjalankan kode yang ditulis model. Baca
[Keamanan](#14-security-notes) dulu sebelum mengaktifkannya di tempat yang penting. Anda juga
boleh memakai tool indeks dan pencarian saja, yang tidak menyentuh eksekusi kode sama sekali.

## Langkah 6 — Daftarkan ke profil

Satu perintah melakukan semuanya: menulis dependency ke `package.json` profil, memasang di
sana, membuat symlink, dan menambahkan nama plugin ke daftar `dsh.profile.bundles` (karena
paket ini mendeklarasikan `dsh.bundle`).

```bash
dsh plugin --profile web add link:/absolute/path/to/ds-context-optimizer
```

Contoh nyata di mesin acuan, di mana repo berada di
`/home/administrator/agent-workspace/project/ds-context-optimizer`:

```bash
dsh plugin --profile web add link:/home/administrator/agent-workspace/project/ds-context-optimizer
```

Aturan perintah ini, dibaca dari sumber DSH CLI (`apps/cli/src/args.ts` dan
`apps/cli/src/plugin.ts`):

- **`dsh plugin` wajib memakai `--profile`.** Itu opsi wajib, bukan nilai bawaan.
- **Urutannya `dsh plugin --profile <nama> <argumen pnpm...>`.** Semua setelah
  `--profile <nama>` diteruskan apa adanya ke pnpm di dalam folder profil, jadi `add`,
  `remove`, `why`, dan `update` bekerja seperti biasa.
- **Gunakan path absolut.** Specifier path relatif (`..`, `./plugin`, `file:../plugin`)
  ditulis ulang relatif terhadap folder tempat perintah dipanggil, yang benar tapi mudah
  keliru kalau dijalankan dari working directory lain.
- **`pnpm` harus ada di `PATH`.** Kalau tidak, CLI mencetak
  `dsh: pnpm not found on PATH` dan keluar dengan kode 127.
- **Repo ini memakai npm; profil memakai pnpm.** Itu tidak masalah. `package-lock.json` di
  sini untuk mengembangkan repo ini, profil menyimpan lockfile pnpm-nya sendiri.

**Jangan menyalin baris loader secara manual.** Anda mungkin tergoda menempel isi
`cordis.patch.yml` ke `cordis.patch.yml` profil. Jangan. Baris patch yang kuncinya `id`
**mengganti** nilai konfigurasi secara keseluruhan, bukan merge dalam, dan id loader kembar
melempar error saat boot. Header komentar di `cordis.patch.yml` sudah bilang ini sendiri.
Pakai `dsh plugin ... add` dan biarkan alatnya menuliskan barisnya.

## Langkah 7 — Verifikasi registrasi tanpa boot

```bash
dsh --profile web --dump-config | grep dsh-context-optimizer
```

`--dump-config` mencetak pohon profil yang sudah terkomposisi lalu keluar tanpa menjalankan
GUI. Anda harus melihat baris loader muncul di keluaran.

Dua hal yang perlu diketahui tentang perintah ini:

- Perintah ini **menulis berkas** ke `$DSH_HOME/profiles/<nama>/cordis.yml` setiap kali
  dijalankan, sebagai bagian dari menyiapkan profil (`apps/cli/src/profile-boot.ts:108`). Kalau
  `$DSH_HOME` read-only, perintah gagal dengan `EROFS`. Itu masalah filesystem, bukan
 instalasi yang rusak.
- `--dump-config` tidak menerima argumen aplikasi tambahan, jadi jangan menaruh apa pun
  sesudahnya.

Kalau `grep` tidak menemukan apa pun, paketnya sudah terpasang tetapi belum masuk lapisan
bundle. Cek `package.json` profil untuk dua hal sekaligus: baris dependency dan nama
`dsh-context-optimizer` di dalam `dsh.profile.bundles`.

Bukti nyata di mesin acuan (profil `web`):

```bash
grep -n 'dsh-context-optimizer' "$DSH_HOME/profiles/web/package.json"
# 20:    "dsh-context-optimizer": "link:/home/administrator/agent-workspace/project/ds-context-optimizer",
# 77:        "dsh-context-optimizer"

ls -la "$DSH_HOME/profiles/web/node_modules/dsh-context-optimizer"
# dsh-context-optimizer -> ../../../../project/ds-context-optimizer
```

## Langkah 8 — Restart profil (tindakan operator)

Plugin hanya dimuat saat profil boot, jadi restart `dsh web` adalah yang mengaktifkannya.
**Restart harness adalah tindakan operator.** Repository ini tidak pernah menjalankannya, dan
tidak ada kode di project ini yang melakukan restart.

Setelah restart, buka sesi agent dan minta agent memanggil `ctx_doctor`. Anda harus mendapat
objek JSON dengan bentuk seperti ini:

```json
{
  "ok": true,
  "version": "0.1.0",
  "node": "v24.19.0",
  "sandbox": {
    "available": true,
    "mode": "workspace-write",
    "allowUnconfined": false,
    "enforced": true
  },
  "runtimes": {
    "python": { "status": "available", "program": "python3", "detail": "found at /usr/bin/python3" },
    "ruby":  { "status": "missing",    "program": "ruby",    "detail": "ruby is not on this PATH" }
  },
  "index": { "sources": 0, "chunks": 0, "bytes": 0, "disk": { "file": 0, "wal": 0, "shm": 0, "total": 0 } },
  "sessions": { "events": 0, "sessions": 0 },
  "routing": { "advisory": true, "denyPatterns": [], "advisoryThrottle": 10 },
  "errors": []
}
```

Cara membacanya:

| Field | Nilai yang baik berarti |
| --- | --- |
| `ok` | `true` kalau plugin tidak merekam warning |
| `sandbox.available` | `true` kalau host menyediakan layanan sandbox yang bisa dipakai |
| `sandbox.enforced` | `true` kalau provider dengan `confine()` sungguhan berhasil ditemukan |
| `runtimes.<bahasa>.status` | `available`, `missing`, atau `unprobeable` |
| `errors` | seluruh warning yang pernah direkam plugin, tanpa duplikat, maksimal 50 |

`unprobeable` sengaja dibuat sebagai status ketiga, bukan boolean. Itu berarti satu entri
`PATH` tidak bisa dibaca, jadi tidak ada kesimpulan apa pun soal apakah runtime-nya terpasang.
Plugin menolak melaporkan "tidak ada" untuk probe yang tidak selesai, karena itu akan membuat
Anda memasang ulang sesuatu yang sudah ada.

## Langkah 9 — Uninstall (kalau perlu)

```bash
dsh plugin --profile web remove dsh-context-optimizer
```

CLI akan menandai ulang daftar bundle terhadap keadaan yang terpasang, jadi namanya hilang dari
`dsh.profile.bundles` dengan sendirinya. Restart profil untuk melepasnya dari memori.

Melepas plugin **tidak** menghapus direktori state. Untuk mengosongkan indeks dan log sesi,
pakai tool-nya sebelum melepas:

```json
{ "confirm": true, "scope": "all" }
```

Atau hapus direktorinya sendiri. Tidak ada yang pernah ditulis di luar `stateDir`.

---

# 4. Configuration

## 4.1 Tidak ada berkas `.env`

Repo ini tidak punya berkas `.env` dan tidak membutuhkannya. Tidak ada API key, tidak ada
password, tidak ada token. Seluruh konfigurasi plugin dibaca dari satu tempat.

## 4.2 Dari mana konfigurasi datang

Hanya dari blok `config:` pada baris loader di
`$DSH_HOME/profiles/<nama>/cordis.patch.yml`. Tidak ada berkas konfigurasi terpisah, tidak ada
environment variable untuk pengaturan plugin, dan tidak ada flag CLI.

Plugin hanya membaca **dua** environment variable:

| Variable | Efek |
| --- | --- |
| `DSH_HOME` | Induk dari `stateDir` bawaan. Kalau kosong, dipakai `HOME`, lalu `.dsh` |
| `DSH_HARNESS_HOME` | Di mana suite test host mencari checkout DSH. Bawaan `/home/administrator/deepseek-harness` |

`PATH` juga berpengaruh, tetapi hanya karena probe runtime dan proses anak sama-sama mencari
program lewat `PATH`. `PATH` dibaca dari lingkungan host, dan hanya nama-nama yang ada di
`executor.envAllowlist` yang diteruskan ke proses anak.

## 4.3 Konfigurasi tanpa perlu menulis apa pun

Plugin bekerja tanpa konfigurasi apa pun. `cordis.patch.yml` mengirim blok `config`-nya dalam
keadaan terkomentari, jadi `apply(ctx, config)` menerima tanpa blok dan plugin memakai
bawaan dari `src/config.ts`.

Untuk mengubah apa pun, aktifkan blok `config:` di
`$DSH_HOME/profiles/<nama>/cordis.patch.yml` dan edit. Ini blok lengkap, sekaligus himpunan
key yang tepat yang diterima resolver:

```yaml
- insert:
    - id: context-optimizer
      name: dsh-context-optimizer
      config:
        stateDir: '/home/administrator/agent-workspace/.dsh/dsh-context-optimizer'
        toolPrefix: 'ctx_'
        executor:
          defaultTimeoutMs: 30000      # anggaran waktu per eksekusi, lalu SIGKILL
          maxStdoutBytes: 8192         # anggaran stdout; ekor disimpan, bukan kepala
          maxStderrBytes: 4096         # anggaran stderr
          sandboxMode: workspace-write # atau read-only
          allowUnconfined: false       # menolak jalan saat tidak ada backend
          envAllowlist: [PATH, LANG, LC_ALL, TZ, NODE_OPTIONS, PYTHONPATH]
          scratchDir: /tmp             # menjadi HOME anak; harus ada dan bisa ditulis
        search:
          defaultLimit: 5              # jumlah hit saat pemanggil tidak menyebut
          maxLimit: 50                 # limit pemanggil di-clamp ke nilai ini
          snippetChars: 240            # karakter per cuplikan, bukan token
        routing:
          advisory: true               # hint berjarak untuk mengarahkan bacaan besar ke indeks
          advisoryThrottle: 10         # paling banyak satu hint per N pemanggilan cocok
          denyPatterns: []             # regex yang dicocokkan ke teks perintah
        session:
          recordEvents: true           # tulis session/event ke SQLite
          maxEventsPerSession: 5000    # baris tertua dipangkas lewat ini
          maxSnapshotChars: 2048       # plafon keras untuk snapshot yang disuntikkan
          injectSnapshot: true         # suntikkan snapshot saat prompt dirakit
        contextBudget:
          enabled: true                # setiap payload tahu anggarannya sendiri
          totalChars: 12000            # plafon total satu payload, sebelum cadangan
          reserveChars: 2000           # karakter yang tidak pernah dialokasikan
          weights:                     # porsi RELATIF, bukan persentase
            recent: 0.2                #   bukti yang baru terlihat
            task: 0.3                  #   tugas yang sedang dikerjakan sesi
            evidence: 0.35             #   bukti hasil retrieval
            metadata: 0.15             #   provenance dan struktur
        cache:
          enabled: true                # cache retrieval lokal di SQLite
          ttlMs: 300000                # umur satu entri cache
          maxEntries: 1000             # batas jumlah entri
        retention:
          ephemeralMs: 86400000        # output perintah sekali pakai (0 = tak pernah)
          sessionMs: 604800000         # baris milik satu sesi
          projectMs: 2592000000        # isi proyek yang terindeks
        relations:
          maxDepth: 2                  # hop maksimum satu penelusuran graf
          maxNodes: 50                 # node maksimum satu penelusuran graf
```

Contoh konfigurasi yang aman untuk pemakaian biasa: salin blok di atas apa adanya, ganti satu
kunci saja bila perlu, lalu **tulis ulang semua kunci lain yang ingin Anda pertahankan**.

Dua aturan yang sering mengejutkan orang:

1. **Baris patch mengganti seluruh nilai `config`. Tidak ada merge dalam.** Kalau Anda
   menimpa dari patch profil dan Omnibus kunci tidak ikut ditulis, kunci itu kembali ke
   bawaan, bukan ke nilai yang pernah Anda tulis sebelumnya.
2. **`stateDir` di-resolve menjadi path absolut** saat dimuat. Path di blok contoh adalah
   path mesin acuan. Ubah ke lokasi yang Anda mau untuk dua berkas SQLite-nya.

Ada satu setelan lagi yang **tidak ada** di blok itu, karena dibaca langsung dari konfigurasi
mentah tanpa melewati validator:

```yaml
config:
  fetch:
    allowHosts: ['internal.example.local']
```

`fetch.allowHosts` adalah opting-out eksplisit untuk Penjaga URL. Secara bawaan,
`ctx_fetch_and_index` menolak host apa pun yang resolve ke alamat loopback, link-local, atau
privat. Tambahkan host ke sini hanya kalau Anda memang ingin mengindeks layanan internal.
Nilai yang rusak diabaikan dan Penjaga tetap aktif; plugin merekam sebuah warning.

## 4.4 Apa yang dianggap konfigurasi rusak

`resolveConfig` (`src/config.ts`) memvalidasi semuanya dan melempar exception pada masukan
buruk. `apply` menangkapnya, merekam alasannya, dan mengembalikan tampilan kosong. **Plugin
menonaktifkan dirinya dengan pesan, bukan melempar exception**, karena lemparan dari `apply`
akan menjatuhkan seluruh profil. Yang ditolak secara spesifik:

- `toolPrefix` yang bukan identifier huruf kecil berakhiran `_`
- `executor.sandboxMode` selain `read-only` atau `workspace-write`. `danger-full-access`
  sengaja tidak ditawarkan dan tidak diterima.
- Entri `routing.denyPatterns` yang tidak bisa dikompilasi sebagai regex. Ini dikompilasi
  saat load dengan sengaja, supaya pattern rusak tidak bisa boot bersih lalu gagal membuka
  secara senyap saat dipanggil.
- Tipe salah untuk field numerik atau boolean
- String kosong di tempat yang mewajibkan nilai
- `fetch.allowHosts` yang bukan array string non-kosong (yang ini diabaikan dengan warning,
  bukan menonaktifkan plugin, karena dibaca di luar validator)

## 4.5 Tabel referensi konfigurasi

| Key | Tipe | Bawaan | Arti |
| --- | --- | --- | --- |
| `stateDir` | string | `$DSH_HOME/dsh-context-optimizer` | Lokasi dua berkas SQLite |
| `toolPrefix` | string | `ctx_` | Awalan pada empat belas nama tool |
| `executor.defaultTimeoutMs` | integer positif | `30000` | Anggaran waktu per eksekusi |
| `executor.maxStdoutBytes` | integer positif | `8192` | Anggaran stdout sebelum pemotongan kepala+ekor |
| `executor.maxStderrBytes` | integer positif | `4096` | Anggaran stderr |
| `executor.sandboxMode` | `read-only` atau `workspace-write` | `workspace-write` | Kebijakan efek file yang diminta ke host |
| `executor.allowUnconfined` | boolean | `false` | Jalankan tanpa batas saat tidak ada backend |
| `executor.envAllowlist` | array string | `[PATH, LANG, LC_ALL, TZ, NODE_OPTIONS, PYTHONPATH]` | Satu-satunya variabel host yang diwarisi anak |
| `executor.scratchDir` | string | `/tmp` | Menjadi `HOME` anak; harus ada dan bisa ditulis |
| `search.defaultLimit` | integer positif | `5` | Hit yang dikembalikan saat pemanggil tidak menyebut |
| `search.maxLimit` | integer positif | `50` | Plafon `limit` dari pemanggil |
| `search.snippetChars` | integer positif | `240` | Karakter per cuplikan (plafon 2000) |
| `routing.advisory` | boolean | `true` | Tempel hint berjarak untuk bacaan besar |
| `routing.advisoryThrottle` | integer non-negatif | `10` | Satu hint per N pemanggilan cocok |
| `routing.denyPatterns` | array string | `[]` | Regex yang menolak panggilan outright |
| `session.recordEvents` | boolean | `true` | Rekam `session/event` ke SQLite |
| `session.maxEventsPerSession` | integer non-negatif | `5000` | Baris tertua dipangkas lewat ini |
| `session.maxSnapshotChars` | integer positif | `2048` | Plafon keras snapshot yang disuntikkan |
| `session.injectSnapshot` | boolean | `true` | Suntikkan snapshot saat prompt dirakit |
| `contextBudget.enabled` | boolean | `true` | Setiap payload menghitung anggarannya lewat `src/budget.ts` |
| `contextBudget.totalChars` | integer positif | `12000` | Plafon karakter satu payload, sebelum cadangan |
| `contextBudget.reserveChars` | integer non-negatif | `2000` | Karakter yang tidak pernah dialokasikan; harus lebih kecil dari `totalChars` |
| `contextBudget.weights.recent` | number 0..1 | `0.2` | Porsi relatif bukti yang baru terlihat |
| `contextBudget.weights.task` | number 0..1 | `0.3` | Porsi relatif tugas sesi |
| `contextBudget.weights.evidence` | number 0..1 | `0.35` | Porsi relatif bukti hasil retrieval |
| `contextBudget.weights.metadata` | number 0..1 | `0.15` | Porsi relatif provenance dan struktur |
| `cache.enabled` | boolean | `true` | Cache retrieval lokal di SQLite |
| `cache.ttlMs` | integer positif | `300000` | Umur satu entri cache |
| `cache.maxEntries` | integer positif | `1000` | Batas jumlah entri; entri tertua dikeluarkan lebih dulu |
| `retention.ephemeralMs` | integer non-negatif | `86400000` | Umur setelah output perintah sekali pakai bisa di-GC |
| `retention.sessionMs` | integer non-negatif | `604800000` | Umur setelah baris milik satu sesi bisa di-GC |
| `retention.projectMs` | integer non-negatif | `2592000000` | Umur setelah isi proyek terindeks bisa di-GC; `0` berarti tak pernah |
| `relations.maxDepth` | integer 1..5 | `2` | Hop maksimum satu penelusuran graf |
| `relations.maxNodes` | integer 1..500 | `50` | Node maksimum satu penelusuran graf |
| `fetch.allowHosts` | array string | `[]` | Host yang dikecualikan dari Penjaga alamat privat |

Bobot anggaran bersifat **relatif**, bukan persentase: `src/budget.ts` menormalkannya, jadi
`evidence: 7` dengan tiga lainnya bawaan tetap sah. Yang ditolak adalah bobot negatif, bukan
jumlah selain 1. Nilai `0` pada `retention.*Ms` berarti "tak pernah dibuang karena umur" dan itu
nilai yang didokumentasikan, bukan sakelar tersembunyi.

## 4.6 Cara kerja hint routing

Dengan `routing.advisory: true`, panggilan tool yang selesai dan cocok dengan salah satu
bentuk berikut akan mendapat satu baris hint yang ditempel ke percakapan, paling banyak satu
per `advisoryThrottle` pemanggilan cocok. Panggilan itu sendiri tidak pernah diblokir.

| Anda memanggil | Dengan | Hint menyarankan |
| --- | --- | --- |
| `web_fetch` atau `read_page` | | `ctx_fetch_and_index` |
| `read` | `file_path` tanpa `offset` dan tanpa `limit` | `ctx_index` |
| `bash` atau `shell` | perintah diawali `curl` atau `wget` | `ctx_fetch_and_index` |
| `bash` atau `shell` | `cat something.log/.json/.csv/.jsonl` | `ctx_batch_execute` |
| `grep` | | `ctx_search` |

Aturan `read` hanya menyala untuk pembacaan **seluruh berkas**. Host membatasi `read` pada
sejumlah baris, jadi membaca berkas kecil memang murah dan tidak diarahkan; yang dialihkan hanya
panggilan yang tidak meminta offset maupun limit sama sekali.

Aturan ini bukan daftar lengkap alur kerja. Empat alur lainnya — query berulang, pertanyaan
historis, bukti yang bertentangan, dan simbol yang berelasi — bukan properti dari **bentuk
panggilan**, melainkan dari apa yang retrieval kembalikan. Karena itu keempatnya dilaporkan
sebagai `hints` pada hasil `ctx_search` (dan `ctx_batch_execute`), bukan ditebak dari argumen:
aturan yang menebak intent dari nama tool akan menyala pada panggilan yang salah dan diam pada
yang benar.

Penolakan berdiri sendiri dan sepenuhnya opt-in. `routing.denyPatterns` kosong secara bawaan,
dan tiap entri adalah regex yang dicocokkan ke argumen `command` milik panggilan. Kecocokan
mengembalikan `{kind: 'deny', reason}` dan tool tidak pernah dijalankan.

---

# 5. Database dan layanan eksternal

## 5.1 Yang dipakai: dua berkas SQLite

Tidak ada database server, tidak ada Docker, tidak ada koneksi jaringan saat boot. Penyimpanan
adalah SQLite bawaan Node (`node:sqlite`), jadi tidak ada yang perlu diinstal.

| Berkas | Isi |
| --- | --- |
| `index.sqlite` | Indeks full-text (FTS5) dari semua sumber yang diindeks |
| `sessions.sqlite` | Log kejadian sesi dan snapshot yang dibangun |

Plus berkas samping `-wal` (write-ahead log) dan `-shm`.

Lokasi bawaannya:

```bash
ls -la "$DSH_HOME/dsh-context-optimizer"
```

## 5.2 Migration, seeding, initialization

**Ada, dan berversi.** `src/migration.ts` menjalankan langkah bernomor per berkas store.

- Tiap store punya tabel `schema_migrations(version, name, applied_at)`. Versi yang tercatat
  adalah sumber kebenaran, bukan bentuk tabel yang kebetulan ada.
- Setiap langkah berjalan di dalam SATU transaksi (`BEGIN IMMEDIATE` ... `COMMIT`). Langkah yang
  gagal di-rollback dan `migrate` melempar `MigrationError` yang menyebut berkas dan nomor
  versinya. Database tetap berada di versi sebelumnya dengan datanya utuh — itu satu-satunya
  keadaan dari mana percobaan ulang atau rebuild masih mungkin.
- Dua langkah dengan nomor versi sama ditolak sebelum SQL apa pun dijalankan.
- Tidak ada seed. Indeks mulai kosong.

### Apa yang terjadi pada database v0.1

Database yang ditulis versi 0.1 punya tabel tapi belum punya baris versi. Runner **mencapinya
sebagai versi 1** (baseline yang sudah dipenuhinya), lalu menjalankan langkah 2:

- kolom provenance dan temporal ditambahkan ke `sources`,
- tabel `chunk_meta` dibuat,
- **hash tiap chunk dihitung dari teks yang benar-benar masih disimpan oleh FTS5**, jadi hash-nya
  menggambarkan korpus yang ada, bukan korpus hasil rebuild,
- `line_start` dan `line_end` sengaja dibiarkan `NULL`: indeks lama tidak menyimpan offset per
  berkas, dan nomor baris yang dikarang sekarang tidak bisa dibedakan dari yang asli nanti.

Terverifikasi langsung: sebuah store v0.1 berisi satu source dengan satu chunk tetap punya
`sources: 1, chunks: 1` setelah migrasi, isinya tetap bisa dicari, hash-nya terisi 64 heksadesimal,
dan `line_start` tidak ada. Membuka store yang sama dua kali tidak menerapkan langkah apa pun.

Kalau migrasi gagal, `apply` menangkapnya, merekam alasannya, dan menonaktifkan plugin dengan pesan —
sama seperti konfigurasi yang rusak. Jalur rebuild yang eksplisit tetap `ctx_purge`.

## 5.3 Layanan eksternal

Tidak ada.Repo ini tidak memanggil layanan pihak ketiga saat build, test, atau boot.

Satu-satunya akses jaringan ada di `ctx_fetch_and_index`, dan itu hanya terjadi kalau model
memanggil tool itu secara eksplisit dengan sebuah URL.

## 5.4 Membersihkan data

```json
// kosongkan indeks saja
{ "confirm": true, "scope": "index" }

// kosongkan log sesi saja
{ "confirm": true, "scope": "sessions" }

// kosongkan keduanya
{ "confirm": true, "scope": "all" }
```

`confirm` harus literal `true`. Tanpa itu, tidak ada yang dihapus dan plugin mengatakannya:

```json
{ "ok": false, "deleted": false, "reason": "confirm was not true; nothing was removed", "scope": "index" }
```

Nilai itu terukur langsung pada 2026-10-07 saat pengujian end-to-end.

Alternatifnya, hapus foldernya sendiri:

```bash
rm -rf "$DSH_HOME/dsh-context-optimizer"
```

**Hentikan profil dulu** sebelum menghapus manual, supaya tidak ada proses yang sedang
menulis ke berkas yang sama.

---

# 6. Menjalankan project

## 6.1 Plugin bukan proses mandiri

Tidak ada perintah seperti `npm start` untuk repo ini. Plugin dimuat oleh DSH saat profil boot.
Perintah yang perlu dijalankan adalah perintah milik DSH:

```bash
# GUI browser (profil web)
dsh web
```

Pada mesin acuan, GUI-nyasiaConstruction di `127.0.0.1:13080`. Buka URL itu di browser setelah
profil boot.

**Perlu dikonfirmasi:** perintah tepat untuk menjalankan profil non-GUI (misalnya profil
`headless`) tidak diuji di repository ini. Lihat `dsh --help` pada instalasi Anda.

**Restart adalah tindakan operator.**ULLJika plugin baru dipasang, tool tidak akan muncul
sampai profil di-restart, dan repository ini tidak pernah menjalankan restart untuk Anda.

## 6.2 Tanda setup berhasil

Semua empat tanda berikut harus benar. Keempatnya terukur langsung pada host acuan,
2026-10-07.

1. **Tool muncul di daftar tool.** Empat belas nama `ctx_*` ada berdampingan dengan `bash`, `read`,
   dan tool bawaan lain.
2. **`ctx_doctor` menjawab `ok: true`.**
3. **Panggilan kode pertama berhasil.** Minta agent menjalankan
   `{ "language": "python", "code": "print(sum(range(100)))" }`. Hasil yang diharapkan:
   `ok: true`, `exitCode: 0`, `stdout: "4950"`.
4. **Indeks bertambah.** Panggil `ctx_index` lalu `ctx_stats`; angka `sources` dan `chunks`
   harus naik dari 0.

## 6.3 Kalau ada beberapa profil

Plugin bisa dipasang di lebih dari satu profil; tiap profil punya store sendiri kalau
`stateDir` dibedakan. Kalau dua profil memakai `stateDir` bawaan yang sama, keduanya menulis ke
SQLite yang sama. Itu tidak merusak apa pun, tapi artinya agen-agen itu berbagi data. Kalau Anda ingin
isolasi penuh, set `stateDir` berbeda per profil.

**Perlu dikonfirmasi:** perilaku dua proses DSH menulis ke satu berkas SQLite yang sama belum
diuji di repository ini. Atur `stateDir` per profil bila Anda ragu.

---

# 7. First use / Quick start

## 7.0 Cara memanggil tool ini

Tool `ctx_*` dipanggil **oleh model**, bukan oleh Anda lewat terminal. Praktisnya: buka sesi
agent, lalu toughest dalam bahasa biasa, misalnya "panggil `ctx_doctor` dan tampilkan JSON
mentahnya".

Kalau Anda ingin menguji tanpa agent sama sekali, jalankan test suite:

```bash
npm test
```

Argumen di bawah ditulis dalam bentuk JSON seperti yang dilihat model, supaya Anda tahu
bentuk persis seperti yang dilihat model. Untuk mencobanya sendiri, cukup berikan instruksi model dengan argumen
yang sama.

## 7.1 Cek kesehatan: `ctx_doctor`

```json
{}
```

Hasil nyata pada host acuan (dipotong agar pendek):

```json
{
  "ok": true,
  "version": "0.1.0",
  "node": "v24.19.0",
  "sandbox": { "available": true, "mode": "workspace-write", "allowUnconfined": false, "enforced": true },
  "runtimes": {
    "javascript": { "status": "available", "program": "node", "detail": "found at /home/administrator/.nvm/versions/node/v24.19.0/bin/node" },
    "typescript": { "status": "available", "program": "node", "detail": "found at /home/administrator/.nvm/versions/node/v24.19.0/bin/node" },
    "python":     { "status": "available", "program": "python3", "detail": "found at /usr/bin/python3" },
    "bash":       { "status": "available", "program": "bash", "detail": "found at /usr/bin/bash" },
    "go":         { "status": "missing", "program": "go", "detail": "go is not on this PATH" }
  },
  "index": { "sources": 5, "chunks": 39, "bytes": 650608, "disk": { "file": 32768, "wal": 585072, "shm": 32768, "total": 650608 } },
  "sessions": { "events": 166, "sessions": 5 },
  "routing": { "advisory": true, "denyPatterns": [], "advisoryThrottle": 10 },
  "errors": []
}
```

Ini juga tool yang paling tepat untuk ditempelkan ke laporan bug.

## 7.2 Jalankan kode pertama: `ctx_execute`

```json
{ "language": "python", "code": "print(sum(range(100)))" }
```

Hasil nyata terukur: `{"ok": true, "exitCode": 0, "stdout": "4950\n", "enforcement": "full", ...}`

Argumennya:

| Argumen | Tipe | Wajib | Bawaan | Arti |
| --- | --- | --- | --- | --- |
| `language` | salah satu dari dua belas bahasa di [2.3](#23-runtime-bahasa-opsional-per-bahasa) | ya | | Runtime mana yang dipakai |
| `code` | string | ya | | Programnya, dikirim lewat stdin |
| `timeoutMs` | integer | tidak | `executor.defaultTimeoutMs` (30000) | Anggaran waktu, plafon 600000 |

Yang dikembalikan: `ok`, `exitCode`, `stdout`, `stderr`, `truncated`, `enforcement`,
`unconfined`, `cwd`, `language`.

Tiga field yang perlu diperhatikan:

- **`truncated`** `true` kalau output melebihi `maxStdoutBytes` atau `maxStderrBytes`. Teksnya
  lalu membawa penanda `...[truncated]...` di antara kepala dan ekor yang dipertahankan.
  **Ekor** yang disimpan, karena baris terakhir yang biasanya Anda butuhkan.
- **`enforcement`** bernilai `full` atau `partial`. `partial` juga mencakup jalannya yang
  memang tidak sempat mulai.
- **`unconfined`** `true` hanya saat tidak ada backend dan `allowUnconfined` diaktifkan
  eksplisit. Dengan bawaan `false`, panggilan menolak:

  ```json
  { "ok": false, "error": "no sandbox backend is available on this host and sandbox.allowUnconfined is false; refusing to run model-authored code unconfined", "sandboxAvailable": false }
  ```

Exit 124 berarti kehabisan waktu. Exit 137 berarti jalannya dibatalkan. Keduanya tidak pernah
dilaporkan sebagai sukses.

### Contoh lanjutan yang terukur

```json
{ "language": "bash", "code": "pwd; echo $HOME; env | cut -d= -f1 | sort | tr '\\n' ' '" }
```

Hasil nyata: `cwd` = folder project, `HOME` = `/tmp`, dan daftar key environment anak hanya
`HOME LANG PATH PWD SHLEVL _`. Tidak ada satu pun key host yang ikut terbawa.

## 7.3 Eksekusi terhadap satu berkas: `ctx_execute_file`

```json
{
  "language": "python",
  "path": "package.json",
  "code": "import os, json; print(json.load(open(os.environ['TARGET_FILE']))['name'])"
}
```

Berkas tersedia sebagai environment variable `TARGET_FILE`. Hasil nyata terukur:

```text
TARGET_FILE=/home/administrator/agent-workspace/project/ds-context-optimizer/package.json
```

Path di-resolve lewat `realpath` lalu dibandingkan secara kanonik terhadap root project, jadi
symlink di dalam project tidak bisa keluar dari sana. **Path wajib sudah ada.** Path yang tidak
ada ditolak, bukan diteruskan:

```json
{ "ok": false, "error": "Path does not exist: package.json", "path": "package.json" }
```

## 7.4 Banyak perintah sekaligus: `ctx_batch_execute`

```json
{
  "commands": [
    { "label": "node-version", "command": "node -v" },
    { "label": "line-count", "command": "wc -l src/index.ts" },
    { "label": "git-head", "command": "git log --oneline -1" }
  ],
  "queries": ["41933b0"]
}
```

Hasil nyata terukur:

```json
{
  "ok": true,
  "aborted": false,
  "indexed": [
    { "label": "node-version", "source": "batch:0:node-version", "exitCode": 0, "chunks": 1, "bytes": 9, "truncated": false },
    { "label": "line-count",  "source": "batch:1:line-count",  "exitCode": 0, "chunks": 1, "bytes": 18, "truncated": false },
    { "label": "git-head",     "source": "batch:2:git-head",     "exitCode": 0, "chunks": 1, "bytes": 68, "truncated": false }
  ],
  "results": [
    { "query": "41933b0", "matches": [
      { "source": "batch:2:git-head", "ordinal": 0, "score": 5.338996267772006,
        "snippet": "»41933b0« Rewrite README as a step-by-step guide for first-time users\n" }
    ] }
  ],
  "skipped": 0
}
```

Dua pelajaran dari hasil ini:

1. **Query harus benar-benar ada di output.** Percobaan pertama memakai query `version`,
   `baris`, dan `commit`, dan ketiganya mengembalikan `matches: []`. Itu benar, bukan bug:
   keluaran `node -v` adalah `v24.19.0`, bukan kata "version".
2. **Nama source memuat posisi** (`batch:2:git-head`) dengan sengaja, karena dua perintah
   boleh memakai label yang sama dan nama source bersama akan membuat yang kedua menimpa yang
   pertama.

`ok` hanya `true` bila **semua** perintah yang diindeks keluar dengan kode 0. `aborted: true`
berarti panggilan Anda dibatalkan, jadi `indexed[]` yang pendek berarti ada perintah yang
dilewati, bukan semuanya sukses. `skipped` menghitung perintah lewat dari batas 64 entri.

## 7.5 Indeks lalu cari: `ctx_index` dan `ctx_search`

```json
{ "path": "src", "source": "e2e-src" }
```

Hasil nyata terukur: `{"ok": true, "files": 13, "indexed": 13, "excluded": 0, "skipped": 0,
"failures": 0, "bytes": 138402, "chunks": 35, "applied": true}`

Lalu cari:

```json
{ "queries": ["README"], "limit": 3 }
```

Hasil nyata terukur: hit teratas adalah cuplikan dari sumber batch, dengan skor BM25 dan
penanda `»…«` diAround term yang cocok.

Argumen `ctx_index`:

| Argumen | Tipe | Wajib | Bawaan | Arti |
| --- | --- | --- | --- | --- |
| `path` | string | tidak | `.` | Berkas atau direktori, relatif terhadap project |
| `source` | string | tidak | `project:<nama folder>` | Label yang disimpan bersama chunk |
| `maxFiles` | integer | tidak | 200 | Plafon berkas yang ditelusuri |
| `maxDepth` | integer | tidak | 5 | Plafon kedalaman direktori |
| `exclude` | array string | tidak | `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage` | Segmen path yang dilewati |

Batas yang tidak bisa dikonfigurasi: berkas di atas 1 MB dilewati, dan satu panggilan membaca
maksimal 32 MB total. Tiap berkas disimpan dengan baris header `FILE <path>` supaya cuplikan
menyebut asalnya.

`exclude` mencocokkan **segmen path utuh**, bukan substring. Jadi `build` bawaan tidak
menghapus `src/build-tools`.

**Yang paling penting: indeks yang gagal tidak pernah menghapus yang sudah ada.** Kalau
penelusuran tidak menemukan apa pun yang bisa dibaca, panggilan mengembalikan `ok: false`,
menyebutkan sebabnya di `hint`, dan meninggalkan indeks lama untuk source itu tetap utuh dan
bisa dicari:

```json
{
  "ok": false,
  "error": "found nothing readable under docs/old; existing source \"my-docs\" left untouched",
  "hint": "every candidate file was skipped",
  "chunks": 12,
  "applied": false
}
```

Baca `applied` untuk tahu apakah penulisan terjadi. `chunks` nilainya sama sebelum dan
sesudah penolakan, jadi tidak bisa dipakai sebagai petunjuk itu sendiri.

Argumen `ctx_search`:

| Argumen | Tipe | Wajib | Bawaan | Arti |
| --- | --- | --- | --- | --- |
| `queries` | array string | ya | | Maksimal 32 term per query |
| `limit` | integer | tidak | `search.defaultLimit` (5) | Di-clamp ke `search.maxLimit` (50) |
| `source` | string | tidak | semua source | Batasi ke satu sumber terindeks |
| `sort` | `relevance` atau `timeline` | tidak | `relevance` | `timeline` berarti chunk terbaru dulu |
| `temporal` | `any`, `latest`, atau `historical` | tidak | `any` | `latest` menaruh chunk terbaru di depan, `historical` yang tertua |
| `before` | ISO-8601 atau epoch ms | tidak | | Hanya bukti yang ditulis pada atau sebelum waktu itu |
| `after` | ISO-8601 atau epoch ms | tidak | | Hanya bukti yang ditulis pada atau setelah waktu itu |
| `sessionId` | string | tidak | | Hanya bukti yang diindeks untuk sesi itu |
| `noCache` | boolean | tidak | `false` | Lewati cache retrieval untuk panggilan ini |

Kalau `before` lebih besar dari `after`, panggilan **ditolak** dengan alasan yang menyebut field-nya.
Frasa relatif seperti `last week` atau `kemarin` sengaja tidak diterjemahkan: frasa seperti itu
harus dievaluasi terhadap jam yang tidak dimiliki tool, jadi pemanggil harus menyerahkan
timestamp.

### Yang ditambahkan pada hasil `ctx_search`

Setiap hasil kini membawa, selain `matches`:

- `provenance` di setiap hit: `evidenceId`, `sourceId`, `chunkId`, `contentHash`, `updatedAt`,
  `firstSeenAt`, `sourceType`, dan `lineStart`/`lineEnd` **hanya bila sumbernya punya metadata baris
  yang sesungguhnya**. Nomor baris tidak pernah dikarang.
- `quality`: skor deterministik (`relevance`, `freshness`, `coverage`, `diversity`,
  `contradictionPenalty`, `overall`), dibulatkan ke 2 desimal. Bukan probabilitas kebenaran.
- `contradictions`: konflik berkeyakinan tinggi yang ditemukan di antara hit yang dikembalikan.
- `temporal`: filter yang benar-benar dipakai setelah parsing.
- `cache`: `hit`, `key`, dan apakah payload disimpan.
- `hints`: paling banyak tiga baris singkat yang mengatakan apa yang bisa dilakukan berikutnya.

Peringkatannya FTS5 BM25, jadi ini peringkat relevansi sungguhan dengan stemming, bukan
sekadar menghitung substring. Term yang cocok dibungkus `»` dan `«`; `…` menandai teks yang
dipotong.

Teks query dipecah pada karakter non-alfanumerik dan tiap term diapit tanda kutip sebelum
masuk ke FTS5, jadi query seperti `foo-bar` atau `path/to` tetap jalan dan tidak bisa
menyuntikkan operator FTS5.

## 7.6 Ambil halaman web: `ctx_fetch_and_index`

```json
{ "url": "https://example.com", "query": "Example Domain" }
```

Hasil nyata terukur:

```json
{
  "ok": true,
  "url": "https://example.com/",
  "source": "e2e-example",
  "chunks": 1,
  "bytes": 577,
  "truncated": false,
  "summary": "Example Domain This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.",
  "results": [
    { "source": "e2e-example", "ordinal": 0, "score": 11.324812500456428,
      "snippet": "»Example« »Domain« This »domain« is for use in documentation examples without needing permission..." }
  ]
}
```

Penjaga pada tool ini paling ketat di plugin:

- Hanya `http` dan `https`. `file:`, `data:`, `gopher:` dan sejenisnya ditolak di tingkat
  scheme.
- URL yang memuat kredensial (`https://user:pass@host`) ditolak.
- Host di-resolve sebelum socket apa pun dibuka; rentang loopback, link-local, dan privat
  ditolak, termasuk ejaan IPv4-mapped IPv6 seperti `::ffff:127.0.0.1`.
- Setiap hop redirect diperiksa ulang, sampai 5 hop. Redirect diikuti manual supaya 302 ke
  alamat internal tidak bisa lolos.
- Body di-stream dan dipotong di `maxBytes`, lalu koneksi ditutup.
- Seluruh panggilan berjalan dengan batas waktu dari `executor.defaultTimeoutMs`, di-clamp
  antara 1 detik dan 10 menit. Resolusi DNS juga masuk anggaran itu.

## 7.7 Lanjutkan sesi: `ctx_resume`

```json
{}
```

Hasil nyata terukur:

```json
{
  "ok": true,
  "sessionId": "session-7b9cbe58-df6e-4de3-9b8a-f65a16a8737e",
  "snapshot": "<session_snapshot>\n  <goal>\n    <item>...</item>\n  </goal>\n  <active_files>...</active_files>\n  <recent_errors>...</recent_errors>\n  <decisions>...</decisions>\n</session_snapshot>"
}
```

Snapshot yang sama juga disuntikkan otomatis ke prompt berikutnya, diawali baris:

```text
[context-optimizer] Earlier context from this session, recovered from the local event log:
```

Kalau sesi Anda masih berjalan di DSH, baris itu akan muncul di konteks giliran Anda sendiri.
Itu bukti injeksi prompt-time bekerja, bukan sekadar `ctx_resume` yang mengembalikan string.

Cara snapshot dibentuk:

1. `session.recordEvents` true berarti listener `session/event` dipasang.
2. Empat tipe kejadian disimpan, sisanya dibuang sebagai derau: `user/message` menjadi kategori
   `goal`, `assistant/message` menjadi `decision`, `tool/call` menjadi `file`, dan
   `tool/result` menjadi `error`. Tiap konten dipotong pada 4000 karakter.
3. `session.maxEventsPerSession` membatasi baris per sesi. Lewat itu, baris tertua dihapus.
4. `ctx_resume`, atau perakitan prompt itu sendiri, membangun dokumen XML dan menyimpannya.
5. Saat prompt dirakit, teksnya disuntikkan seperti di atas.

Paling banyak 5 item per section, tiap item dipotong pada 400 karakter, yang terbaru disimpan.
Section ditambahkan sesuai urutan di atas sampai anggaran `session.maxSnapshotChars` habis.

**`<pending_tasks>` tidak pernah muncul dari jalur penangkapan.** Section itu ada di template,
tetapi `classifyEvent` hanya menghasilkan empat kategori di atas. Perlakukan sebagai tempat
cadangan, bukan fitur.

## 7.7b Perluas bukti: `ctx_expand`

```json
{ "evidenceId": "ev_c9e87c7e4f13583c" }
{ "sourceId": "src_01097f88dc0b1314" }
{ "evidenceId": "ev_c9e87c7e4f13583c", "level": 1, "budgetChars": 500 }
```

| Argumen | Tipe | Wajib | Bawaan | Arti |
| --- | --- | --- | --- | --- |
| `evidenceId` | string | ya* | | Satu evidence id dari hasil pencarian sebelumnya |
| `sourceId` | string | ya* | | Satu source id, untuk mendaftar isi source itu |
| `level` | integer 0..4 | tidak | `4` untuk evidence, `0` untuk source | L0 metadata, L1 struktur, L2 ringkasan, L3 kutipan, L4 mentah |
| `budgetChars` | integer | tidak | potongan bukti dari `contextBudget` | Plafon karakter payload yang dikembalikan |
| `maxChunks` | integer | tidak | 50 | Chunk yang didaftarkan untuk ekspansi source |
| `seenHash` | string | tidak | | Hash dari retrieval sebelumnya, untuk mendeteksi drift |

\* Salah satu dari `evidenceId` atau `sourceId` wajib.

Poin yang paling penting: **argumennya selalu identifier, bukan isi.** Pemanggil tidak pernah
mengirim ulang badan dokumen — kalau harus, seluruh maksud mengindeksnya hilang. Kenapa itu aman:
id hanya dipakai sebagai pembanding kesetaraan di dalam SQL, dengan validasi bentuk
`ev_`/`src_` plus 16 heksadesimal lebih dulu. Karena itu ia tidak bisa menjadi path.

Setiap ekspansi tetap terbatas: L4 (mentah) dipotong pada `budgetChars` **dan** pada
`MAX_EXPANSION_CHARS`, mana saja yang lebih kecil. Plafon bawaan yang terukur pada konfigurasi
standar adalah 3500 karakter.

Perluasan source mendaftar chunk-nya beserta `evidenceId`, `charLen`, dan `lineStart`/`lineEnd`,
tanpa menyertakan teksnya. Model lalu memilih chunk yang mau dibaca. Itu yang membuat dokumen
besar tidak pernah masuk ke konteks sekaligus.

## 7.7c Bersihkan data lama: `ctx_gc`

```json
{ "dryRun": true }
{ "dryRun": false, "confirm": true, "maxDeletes": 20 }
{ "dryRun": false, "confirm": true, "protect": ["src_01097f88dc0b1314"] }
```

| Argumen | Tipe | Wajib | Bawaan | Arti |
| --- | --- | --- | --- | --- |
| `dryRun` | boolean | tidak | `true` | Laporkan saja, jangan hapus |
| `confirm` | boolean | tidak | `false` | Harus `true` untuk run yang benar-benar menghapus |
| `maxDeletes` | integer | tidak | 1000 | Plafon record yang boleh dihapus sekali panggil |
| `protect` | array string | tidak | `[]` | Source atau evidence id yang harus dipertahankan |

Dua flag, bukan satu: run yang menghapus butuh `confirm: true` **dan** `dryRun: false`. Dry run
tetap mendaftar kandidatnya — rencana yang hanya bicara setelah menghapus adalah rencana yang
tidak bisa diperiksa.

Aturan yang membuat tool ini aman dipakai: **usia tidak pernah menghapus apa pun sendirian.**
Satu record bisa diambil kembali hanya bila ia lama DAN tidak dirujuk DAN bukan `persistent`.
Record yang dirujuk tetap dilindungi pada umur berapa pun. Yang dihitung sebagai rujukan adalah
edge graf yang menunjuk ke salah satu chunk-nya, dan apa pun yang pemanggil sebutkan di `protect`.

Balasan melaporkan `scanned`, `reclaimable`, `protected`, dan berapa yang benar-benar dihapus.
`ctx_stats` melaporkan angka ringkas berbasis sampungan terbatas; `ctx_gc` dry run yang membaca
semua baris.

## 7.7d Bedakan apa yang berubah: `ctx_diff`

```json
{ "mode": "sessions", "sessionA": "sess-a", "sessionB": "sess-b" }
{ "mode": "evidence", "before": "ev_aaa", "after": "ev_bbb" }
{ "mode": "source", "before": "project:app", "after": "project:app-after-refactor" }
```

| Argumen | Tipe | Wajib | Arti |
| --- | --- | --- | --- |
| `mode` | `sessions`, `evidence`, atau `source` | ya | Kedua sisi berupa apa |
| `sessionA`, `sessionB` | string | untuk `sessions` | Dua id sesi |
| `before`, `after` | string | untuk `evidence` dan `source` | Evidence id atau label source |
| `maxEntries` | integer | tidak | Plafon entri diff; bawaan 20, clamp 0..100 |

Hasilnya hanya daftar `added`/`removed`/`changed`/`unchanged` yang terbatas, bukan salinan salah
satu sisi. Perbandingan nilainya sengaja **literal**: detektor parafrase akan menebak makna yang
tidak bisa dipertanggungjawabkan modul ini. Tiap `key`, `before`, dan `after` dipotong pada
`MAX_DIFF_ENTRY_CHARS` (160 karakter), sementara keempat penghitung tetap melaporkan total
sebenarnya — entri yang dibatasi dan jumlah yang sebenarnya adalah dua hal yang berbeda.

## 7.7e Telusuri relasi: `ctx_related`

```json
{ "entity": "authenticate", "depth": 2, "limit": 20 }
```

| Argumen | Tipe | Wajib | Bawaan | Arti |
| --- | --- | --- | --- | --- |
| `entity` | string | ya | | Nama entity: fungsi, modul, simbol |
| `depth` | integer | tidak | `relations.maxDepth` | Hop yang ditelusuri, di-clamp ke konfigurasi dan ke 3 |
| `limit` | integer | tidak | `relations.maxNodes` | Plafon node yang dikembalikan |

Entity adalah token buram, bukan path: `normalizeEntity` menolak pemisah path, `..`, token
kosong, dan nama lebih panjang dari 128 karakter. Penelusuran adalah BFS berbatas dengan
himpunan visited, jadi graf bersiklik tetap berhenti dan setiap entity muncul sekali. Setiap node
membawa `evidenceId` edge yang mencapainya, sehingga jawaban relasi tetap bisa dilacak.

## 7.8 Lihat isi store: `ctx_stats`

```json
{}
```

Hasil nyata terukur setelah rangkaian pengujian:

```json
{
  "ok": true,
  "index": { "sources": 5, "chunks": 39, "bytes": 650608,
             "disk": { "file": 32768, "wal": 585072, "shm": 32768, "total": 650608 } },
  "sessions": { "events": 166, "sessions": 5 },
  "stateDir": "/home/administrator/agent-workspace/.dsh/dsh-context-optimizer",
  "indexFile": "/home/administrator/agent-workspace/.dsh/dsh-context-optimizer/index.sqlite",
  "sessionsFile": "/home/administrator/agent-workspace/.dsh/dsh-context-optimizer/sessions.sqlite"
}
```

`bytes` sengaja menyertakan WAL dan shm. Mengukur hanya berkas utama akan melapor sekitar
40% lebih kecil selagi write-ahead log belum di-checkpoint.

Field baru yang perlu diperhatikan:

- `index.evidence` dan `index.stale`: berapa chunk yang punya baris provenance, dan berapa yang
  hash-nya tidak lagi cocok dengan teks yang disimpan. `stale` bukan nol pada korpus sehat
  berarti ada yang menulis di luar store.
- `index.corpusVersion`: naik setiap kali isi berubah. Cache retrieval memakainya sebagai kunci.
- `contextBudget`: utilisasi anggaran (`totalChars`, `usableChars`, bobot yang dinormalkan).
- `cache`: hit, miss, jumlah entri, dan berapa yang dikeluarkan.
- `relations`: jumlah edge dan entity.
- `gc`: record dan byte yang bisa diambil kembali, ditandai `sampled: true` kalau angkanya berasal
  dari sampungan terbatas.

## 7.9 Menghapus: `ctx_purge`

```json
{ "confirm": true, "scope": "index" }
```

Kedua argumen diperiksa ulang di dalam handler, bukan hanya di skema, karena jalur
pendaftaran mentah tidak memvalidasi argumen sebelum handler jalan. `scope` yang hilang atau
tidak dikenal menghapus apa pun dan mengatakannya:

```json
{ "ok": false, "deleted": false, "reason": "invalid scope; nothing was removed" }
```

---

# 8. Project structure

```
ds-context-optimizer/
├── src/
│   ├── index.ts              # entry plugin: definisi 14 tool, hook, fetch, Penjaga URL
│   ├── config.ts             # DEFAULT_CONFIG plus validasi resolveConfig
│   ├── executor.ts           # SandboxExecutor: spawn terkurung, env allowlist, timeout
│   ├── host.ts               # kontrak host DSH yang dituju, diketik manual
│   ├── runtime.ts            # spesifikasi argv per bahasa dan probe PATH
│   ├── security.ts           # resolveProjectPath: confinemen path berbasis realpath
│   ├── migration.ts          # schema_version, langkah bernomor, migrasi atomik
│   ├── store.ts              # ContentStore: chunking, FTS5/BM25, provenance, temporal
│   ├── truncate.ts           # koleksi stdout/stderr berbatas, potongan ekor aman UTF-8
│   ├── types.ts              # tipe hasil dan kebijakan yang dipakai bersama
│   ├── budget.ts             # anggaran konteks terpusat: alokasi, clamp, ukuran
│   ├── fold.ts               # lipatan hierarkis L0..L4 dan parser id ekspansi
│   ├── provenance.ts         # derivasi sourceId/chunkId/evidenceId dan hash
│   ├── temporal.ts           # filter waktu, urutan, dan peluruhan kebaruan
│   ├── contradiction.ts      # deteksi kontradiksi deterministik, tanpa LLM
│   ├── cache.ts              # cache retrieval di SQLite: TTL, batas, invalidasi
│   ├── gc.ts                 # perencanaan retensi: dry run, hitungan, perlindungan
│   ├── diff.ts               # diff ringkas dua snapshot / bukti / versi source
│   ├── quality.ts            # skor kualitas retrieval deterministik
│   ├── graph.ts              # tabel relasi plus penelusuran BFS berbatas
│   ├── retrieval.ts          # SATU pipeline retrieval: cache, temporal, kualitas, kontradiksi
│   ├── routing/
│   │   ├── engine.ts         # evaluate() murni: keputusan allow / advisory / deny
│   │   └── throttle.ts       # AdvisoryThrottle: membatasi frekuensi hint
│   ├── session/
│   │   ├── db.ts             # SessionDB: kejadian dan snapshot di node:sqlite
│   │   └── snapshot.ts       # classifyEvent, eventContent, buildSnapshot
│   └── tools/
│       └── infrastructure.ts # ctx_expand, ctx_gc, ctx_diff, ctx_related
├── test/
│   ├── unit/             # 22 berkas, 317 test, tanpa butuh host
│   └── host/             # 3 berkas, 55 test, Context cordis sungguhan dan bwrap sungguhan
├── dist/                 # hasil build, di-gitignore
├── cordis.patch.yml      # baris loader plus template konfigurasi terkomentari
├── package.json
├── package-lock.json
├── tsconfig.json
└── LICENSE               # MIT
```

## 8.1 Berkas yang paling mungkin akan Anda sentuh

| Kalau Anda mau | Buka ini |
| --- | --- |
| Menambah tool baru | `src/index.ts` (tool didefinisikan dan didaftarkan di sini) |
| Mengubah batas output, timeout, atau mode sandbox | `src/config.ts` (default) lalu `cordis.patch.yml` (nilai profil) |
| Menambah bahasa yang didukung | `src/runtime.ts` (peta bahasa ke program + argumen tetap) |
| Mengubah cara chunking atau peringkat pencarian | `src/store.ts` |
| Mengubah apa yang masuk ke snapshot sesi | `src/session/snapshot.ts` |
| Mengubah keputusan allow/advisory/deny | `src/routing/engine.ts` |
| Memahami batas file | `src/security.ts` |

## 8.2 `src/host.ts` dan kenapa dia ada

Berkas ini deserves perhatian sebelum yang lain. Plugin menyalin permukaan host yang
dipakainya menjadi tipe lokal, **bukan** mengimpor `@deepseek-ai/*`. Alasannya, harness
me-resolve specifier polos sebuah plugin terhadap `node_modules` miliknya sendiri, bukan
milik host. Mengimpor paket aslinya akan memaksa setiap konsumen memasang salinan yang
cocok. Berkas ini membawa rujukan ke baris sumber host yang persis.

## 8.3 Urutan baca untuk pendatang baru

1. `src/types.ts` untuk kosakata
2. `src/host.ts` untuk memahami kontrak host
3. `src/index.ts` untuk melihat bagaimana tool-tool itu disambungkan
4. `src/executor.ts` dan `src/store.ts` untuk dua subsistem yang paling besar

---

# 9. Common commands

## 9.1 Perintah repository ini

| Tujuan | Perintah | Catatan |
| --- | --- | --- |
| Build | `npm run build` | `tsc -p tsconfig.json`, menulis `dist/` |
| Typecheck tanpa emit | `npm run typecheck` | `tsc --noEmit`, tanpa keluaran bila sukses |
| Test lengkap | `npm test` | Build dulu, lalu suite unit + host |
| Test unit saja | `npm run test:unit` | Tidak butuh host DSH |
| Test host | `npm run test:host` | **Gagal** kalau tidak ada checkout DSH |
| Pasang dependency | `npm install` | Tambahkan `--cache ./.npm-cache` bila error `EROFS` |
| Bersihkan hasil build | `rm -rf dist` | Aman, akan dibangun ulang |

Tidak ada script lint, format, atau typecheck tambahan di `package.json`. Kalau Anda butuh
konsistensi gaya, repo ini mengandalkan `strict: true` di `tsconfig.json` sebagai penjaga utamanya.

## 9.2 Perintah DSH yang dipakai plugin ini

| Tujuan | Perintah |
| --- | --- |
| Pasang ke profil | `dsh plugin --profile web add link:/path/absolut/ke/ds-context-optimizer` |
| Copot dari profil | `dsh plugin --profile web remove dsh-context-optimizer` |
| Cek registrasi tanpa boot | `dsh --profile web --dump-config \| grep dsh-context-optimizer` |
| Jalankan GUI | `dsh web` |
| Lihat daftar profil | `ls "$DSH_HOME/profiles"` |

## 9.3 Perintah database

Tidak ada perintah database, dan itu disengaja: tidak ada CLI migrate, tidak ada seed. Skema
dibawa ke versi terbaru otomatis saat store dibuka (`src/migration.ts`), dan versinya terlihat
di `ctx_doctor` pada field `schema`.

---

# 10. Testing

## 10.1 Cara menjalankan

```bash
npm test            # build + unit + host (host dilewati bila checkout tidak ada)
npm run test:unit   # build + unit saja
npm run test:host   # build + host, gagal bila checkout tidak ada
npm run typecheck   # hanya cek tipe
```

## 10.2 Angka hasil ukur

Dihitung ulang per berkas pada sesi perubahan infrastruktur konteks, di mesin acuan (Node v24.19.0). Semua angka di bawah adalah keluaran `node --test` per berkas, bukan kira-kira:

| Berkas test | tests | pass | skip | Cakupannya |
| --- | --- | --- | --- | --- |
| `test/unit/config.test.mjs` | 16 | 16 | 0 | `resolveConfig`: bawaan, override, setiap jalur penolakan |
| `test/unit/config-file.test.mjs` | 5 | 5 | 0 | `cordis.patch.yml` bisa di-parse parser host; contoh konfigurasi di README ini lengkap dan bisa di-resolve |
| `test/unit/executor.test.mjs` | 30 | 30 | 0 | spawn, abort, timeout, env allowlist, pinning HOME dan TARGET_FILE, probe runtime |
| `test/unit/security.test.mjs` | 17 | 17 | 0 | `resolveProjectPath` melawan traversal, symlink keluar, path hilang |
| `test/unit/store.test.mjs` | 17 | 17 | 0 | chunking, peringkat BM25, cuplikan, atomisitas transaksi, purge |
| `test/unit/migration.test.mjs` | 7 | 7 | 0 | basis data kosong, basis data v0.1, migrasi berulang, migrasi gagal |
| `test/unit/budget.test.mjs` | 20 | 20 | 0 | alokasi normal, anggaran mungil, bobot nol, pembulatan, determinisme |
| `test/unit/fold.test.mjs` | 10 | 10 | 0 | setiap level L0..L4, parser id ekspansi, klip aman surrogate |
| `test/unit/provenance.test.mjs` | 16 | 16 | 0 | id stabil, hash, deteksi stale, metadata opsional yang tidak dikarang |
| `test/unit/temporal.test.mjs` | 33 | 33 | 0 | parsing filter, batas inklusif, urutan, peluruhan kebaruan |
| `test/unit/contradiction.test.mjs` | 16 | 16 | 0 | konflik kunci/nilai, boolean, versi; prosa bebas TIDAK jadi kontradiksi |
| `test/unit/cache.test.mjs` | 21 | 21 | 0 | hit, miss, kedaluwarsa, invalidasi korpus, ukuran terbatas, baris rusak |
| `test/unit/gc.test.mjs` | 13 | 13 | 0 | bukti yang dirujuk selamat, cap per sesi, batas hapus, dry run |
| `test/unit/diff.test.mjs` | 12 | 12 | 0 | tambah, hapus, ubah, keluaran terbatas, cuplikan entri |
| `test/unit/quality.test.mjs` | 13 | 13 | 0 | skor bergerak ke arah terdokumentasi saat bukti basi, duplikat, atau bertentangan |
| `test/unit/graph.test.mjs` | 19 | 19 | 0 | relasi langsung, multi-hop, siklik, batas kedalaman dan node |
| `test/unit/retrieval.test.mjs` | 8 | 8 | 0 | pipeline ujung-ke-ujung: cache, korpus berubah, jendela rusak, kontradiksi |
| `test/unit/session.test.mjs` | 21 | 21 | 0 | klasifikasi kejadian, bentuk payload host sungguhan, anggaran snapshot, pemangkasan |
| `test/unit/routing.test.mjs` | 15 | 15 | 0 | keputusan allow/advisory/deny dan throttle |
| `test/unit/truncate.test.mjs` | 8 | 8 | 0 | anggaran byte, potong kepala+ekor, karakter multi-byte tidak pernah terbelah |
| **Subtotal unit** | **317** | **317** | **0** | |
| `test/host/registry.test.mjs` | 47 | 47 | 0 | pipeline host penuh untuk 14 tool, layanan sungguhan, tanpa mock |
| `test/host/confinement.test.mjs` | 7 | 7 | 0 | bubblewrap sungguhan: tulis di dalam boleh, tulis di luar ditolak |
| `test/host/gate.test.mjs` | 1 | 0 | 1 | gagal tertutup saat `CTX_REQUIRE_HOST=1` dan checkout tidak ada |
| **Subtotal host** | **55** | **54** | **1** | |
| **Total `npm test`** | **372** | **371** | **1** | keluar dengan kode 0 |

Ringkasan yang sama, dari keluaran `npm test` pada sesi ini:

```text
ℹ tests 372
ℹ pass 371
ℹ fail 0
ℹ skipped 1
```

## 10.3 Cara tahu test-nya berhasil

Tiga tanda, semuanya harus benar:

1. Baris ringkasan berbunyi `fail 0`.
2. Kode keluar `0`. Cek dengan `echo $?` tepat setelah `npm test`.
3. Tidak ada `not ok` di keluaran.

Contoh keluaran sukses dari mesin acuan:

```text
ℹ tests 176
ℹ pass 175
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 6430.83307
```

Satu-satunya skip itu **disengaja**. Suite host dilewati sendiri kalau tidak ada checkout DSH
yang bisa dijangkau, dan `test/host/gate.test.mjs` mengubah "host tidak tersedia" dari skip
menjadi **kegagalan** saat `CTX_REQUIRE_HOST=1`, yang memang diset oleh `npm run test:host`.
Jadi:

- `npm test` di mesin yang punya checkout: menjalankan semuanya, hanya satu gate yang dilewati.
- `npm test` di mesin tanpa checkout: suite host dilewati, jadi Anda mendapatkan hasil hijau
  yang memang tidak banyak menguji apa pun. Itu perilaku jujur, bukan kegagalan.
- `npm run test:host` tanpa checkout: gagal. Itu yang Anda mau sebelum mempercayai hasil
  verifikasi.

Kalau checkout DSH ada di tempat lain dari bawaan:

```bash
DSH_HARNESS_HOME=/path/ke/deepseek-harness npm run test:host
```

## 10.4 Apa yang sebenarnya dilakukan suite host

`test/host/` tidak memock host. Ia boot `Context` `@deepseek-ai/cordis` sungguhan dari
checkout DSH, memasang layanan `SystemPrompt`, `ToolRuntime`, dan `LocalSandboxProvider`
sungguhan, memasang plugin ini ke `Context` itu, lalu memanggil `ctx.tools.execute(...)`.
Pendaftaran, validasi skema, waterfall pre-execute, eksekusi, dan proyeksi output adalah
pipeline sungguhan yang dilewati satu panggilan tool model. Suite confinemen menjalankan
bubblewrap sungguhan.

## 10.5 Version skew

Suite host mencetak dua versi yang dipakainya. Terukur pada mesin acuan: CLI DSH
`0.1.1-rc.2` dan checkout `packages/core/tools` `@deepseek-ai/dsh-tools` `0.1.1-rc.2`,
sementara profil `web` memakai `@deepseek-ai/dsh-tools` `0.1.0-rc.8`. Test kontrak ditulis
terhadap checkout. Apakah bundel rc.8 berbeda tidak diuji terpisah di repo ini, jadi kalau
Anda melihat sendiri perilaku yang berbeda antara test dan profil, itu jalur yang perlu
diperiksa.

## 10.6 Pelajaran fixture yang layak diwariskan

Dua bug di riwayat repo ini tidak terlihat karena test-nya memberi plugin bentuk payload yang
tidak pernah dihasilkan host.

- `tool/result` dan `assistant/message` membawa teksnya di `data.message.content`, dengan
  hasil tool bersarang sekali lagi di dalam blok `tool-result`. Fixture lama memakai bentuk
  rata `data.content`, jadi ia setuju dengan bug: section `<recent_errors>` dan `<decisions>`
  keluar kosong sementara suite tetap hijau.
- Sebuah assertion pernah mencocokkan token yang muncul di argumen `code` milik test itu
  sendiri, yang persis apa yang akan dikeluarkan renderer output yang rusak. Assertion
  seperti itu hanya bisa lulus karena alasan yang salah.

Saat menambah fixture, cocokkan dengan peta kejadian host yang sungguhan, bukan dengan apa
yang kebetulan dibaca handler.

---

# 11. Troubleshooting

| Gejala | Penyebab dan cara memperbaiki |
| --- | --- |
| `ctx_execute` mengembalikan `no sandbox backend is available on this host` | Host tidak menyediakan layanan `sandbox` yang bisa dipakai. Cek `ctx_doctor`. Jangan buru-buru ke `allowUnconfined: true` kecuali Anda benar-benar mau menjalankan kode yang ditulis model tanpa batas sama sekali. |
| `ctx_doctor` melaporkan bahasa sebagai `unprobeable` | Satu entri `PATH` tidak bisa dibaca. Ini sengaja tidak sama dengan `missing`; plugin tidak akan bilang runtime absen saat tidak bisa memeriksanya. Periksa izin baca direktori di `PATH`. |
| Sepuluh tool `ctx_*` tidak ada di daftar tool | Profil belum di-restart sejak pemasangan, atau paket sudah jadi dependency tapi belum masuk `dsh.profile.bundles`. Cek `dsh --profile <nama> --dump-config \| grep dsh-context-optimizer`, lalu minta operator me-restart profil. |
| `dsh plugin ... add` mencetak `dsh: pnpm not found on PATH` dan keluar 127 | pnpm belum terpasang. DSH CLI meneruskan manajemen plugin ke pnpm. |
| `npm install` gagal dengan `EROFS` di `~/.npm` | Folder home read-only, umum di dalam sandbox agent DSH. Pakai `npm install --cache ./.npm-cache`. |
| `dsh --profile web --dump-config` gagal dengan `EROFS` | Perintah ini menulis `cordis.yml` ke folder profil setiap kali dijalankan, dan `$DSH_HOME` Anda read-only. Jalankan dari shell yang punya akses tulis ke sana. |
| `npm run test:host` gagal dengan assertion checkout tidak ada | Set `DSH_HARNESS_HOME` ke checkout DSH, atau jalankan `npm test` yang akan melewati suite host dengan alasan yang dicetak. |
| Plugin tidak termuat dan `ctx_doctor` tidak tersedia | Konfigurasi ditolak. Cari `[dsh-context-optimizer] configuration rejected` di log host, atau baca array `errors` dari tampilan runtime plugin. |
| `ctx_index` mengembalikan `ok: false` dengan `found nothing readable` | Semua berkas kandidat dilewati, dikecualikan, atau tidak terbaca. Laporan menyebut yang mana lewat `files`, `excluded`, `skipped`, `failures`, dan `hint`. Indeks lama untuk source itu tidak tersentuh. |
| `ctx_purge` bilang `invalid scope; nothing was removed` | `scope` harus persis `index`, `sessions`, atau `all`, dan `confirm` harus literal `true`. Keduanya dicek ulang di handler, bukan hanya di skema. |
| `ctx_execute_file` bilang `Path does not exist` | Plugin menolak path yang tidak bisa dia kanonikalkan. Buat berkasnya dulu. |
| `ctx_fetch_and_index` bilang `url host ... resolves to ..., a private or loopback address` | Berfungsi sebagaimana mestinya. Tambahkan host ke `fetch.allowHosts` hanya kalau Anda benar-benar ingin mengindeks layanan internal. |
| `ctx_execute` untuk bahasa yang tidak terpasang mengembalikan `bwrap: execvp go: No such file or directory` | Program runtime-nya memang tidak ada di `PATH`. Plugin meneruskan pesan OS apa adanya di sini; `ctx_doctor` adalah cara resmi untuk mengecek status runtime. Lihat [Known issues](#known-issues-dari-audit-e2e-dan-source-review) butir 2. |
| `ctx_search` tidak menemukan kata yang Anda yakin ada | Pencarian memakai tokenisasi FTS5. Query dipecah pada karakter non-alfanumerik, jadi `zzz-token-yang-tidak-pernah-ada` berubah jadi term `zzz`, `token`, `yang`, `tidak`, `pernah`, `ada` dan bisa mencocokkan baris yang cuma memuat `token`. Coco-kan query dengan potongan output yang benar-benar ada, seperti pada [7.4](#74-banyak-perintah-sekaligus-ctx_batch_execute). |
| Dua implementasi dengan nama `ctx_*` yang sama muncul | Profil Anda mungkin sudahoyan menyediakan empat belas nama ini lewat MCP server. Host memberi awalan nama server pada tool MCP, jadi tidak ada tabrakan registrasi, tapi ada tumpang tindih fungsional. Pilih salah satu, atau ubah `toolPrefix`. |
| `A patch row replaces the whole config value` menggigit Anda | Tulis ulang setiap kunci yang ingin dipertahankan di blok `config:`. Tidak ada merge dalam. |
| `ctx_stats` melaporkan ukuran yang jauh lebih besar dari berkas yang terlihat di disk | `bytes` sengaja menyertakan WAL dan `-shm`. Berkas utama 32 KB dengan WAL 585 KB adalah kondisi normal saat checkpoint SQLite belum berjalan. |

---

# 12. Development guide

## 12.1 Siklus kerja harian

```bash
# 1. edit berkas di src/
# 2. cek tipe
npm run typecheck

# 3. build + test
npm test

# 4. commit hanya src/ dan test/
git add src test
git commit -m "deskripsi singkat perubahan"
```

Sebelum commit:

```bash
git status --porcelain
git diff
```

Yang **tidak boleh** ikut ter-commit, dan sudahDiamankan oleh `.gitignore`:

```text
node_modules/
dist/
.npm-cache/
.tmp-ctxopt-*
*.sqlite
*.sqlite-shm
*.sqlite-wal
```

`.gitignore` juga menutup `*.sqlite`, jadi kalau Anda pernah menguji langsung di dalam folder
repo, berkas basis data lokal tidak akan bocor ke commit.

## 12.2 Menambah tool baru

Semua tool didaftarkan di `src/index.ts`. Alurnya:

1. Tulis definisi tool (nama, deskripsi, skema argumen, handler) mengikuti pola tool yang ada.
2. Tambahkan ke daftar yang di-*register* ke `ctx.tools.register(...)`.
3. Tambahkan test di `test/host/registry.test.mjs` yang memanggilnya lewat pipeline host
   sungguhan, bukan memanggil handler secara langsung.
4. Jalankan `npm test`.

**Penting soal skema:** di DSH, `defineTool` mewajibkan `additionalProperties` ada dan
eksplisit pada setiap skema objek, termasuk `output.schema` dan setiap properti objek bersarang.
Perilaku ini sudah berubah dari rc ke rc; kalau registrasi ditolak dengan `JsonSchemaError`,
periksa itu lebih dulu.

## 12.3 Gate sebelum commit

Tidak ada linter, jadi gate-nya adalah:

| Gate | Perintah | Yang dijaga |
| --- | --- | --- |
| Tipe | `npm run typecheck` | `strict: true`, jadi setiap kesalahan tipe menggagalkan |
| Test | `npm test` | Perilaku yang dikunci test, termasuk kontrak host |
| Diff | `git diff` | Tidak ada perubahan yang tidak disengaja |

Kalau Anda menambahkan formatter atau linter, hook-nya ke `npm run typecheck` dan `npm test`
dalam satu perintah, dan catat alasannya di README bagian ini.

## 12.4 Jangan percaya test yang menguji bentuk, bukan perilaku

Satu aturan yang berulang kali terbukti di repo ini: test baru harus dikunci dengan pengujian
yang melewati batas serialisasi dan eksekusi sungguhan. Assert bahwa objek punya bentuk yang
benar, atau bahwa sebuah argumen pernah diterima, bukan bukti bahwa alurnya bekerja.

Contoh nyata yang pernah menyesatkan: `output.render` sempat hanya menerima satu parameter,
padahal host memanggilnya dengan dua. Akibatnya tidak ada hasil tool yang pernah sampai ke
model, sementara test tetap hijau karena cuma memeriksa bentuk objek. Perbaikannya butuh test
yang memanggil `ctx.tools.execute(...)` dan membaca konten yang benar-benar dilihat model.

## 12.5-state index saat menguji

`stateDir` bawaan menunjuk ke direktori milik instalasi DSH, jadi pengujian dari dalam agent
akan menulis ke store milik host. Kalau Anda butuh menguji tanpa menyentuh store host, arahkan
`stateDir` ke folder sementara di dalam project, dan ingat itu tidak masuk `.gitignore` untuk
path di luar pola di atas, jadi bersihkan setelah selesai.

---

# 13. Deployment

## 13.1 Apa arti "deploy" untuk plugin ini

Plugin DSH tidak punya image, tidak punya service, dan tidak punya port. Deployment-nya berarti
**mendaftarkan paket ke dalam profil** yang akan dipakai orang. Karena itu hanya ada tiga
bentukdeployment.

| Opsi | Cara | Kapan dipakai |
| --- | --- | --- |
| A. Link path lokal | `dsh plugin --profile web add link:/path/absolut/ke/ds-context-optimizer` | **Direkomendasikan untuk satu mesin.** Paling sederhana, perubahan langsung terlihat setelah build + restart |
| B. Terbitkan ke registry | `npm publish`, lalu `dsh plugin --profile web add dsh-context-optimizer@<versi>` | Beberapa mesin, atau anggota tim lain |
| C. Vendor berkas | menyalin folder ke dalam mesin target lalu Opsi A | Mesin tanpa akses ke path asalnya |

**Rekomendasi untuk newbie: Opsi A.** Alasannya, tidak ada versioning yang harus dijaga, tidak
ada kredensial registry, dan `git pull` di path yang sama sudah cukup untuk memperbarui kode.

**Perlu dikonfirmasi:** Opsi B membutuhkan konfigurasi registry untuk CLI DSH, dan repo ini
tidak punya dokumentasi maupun uji untuk jalur itu. Perlakukan sebagai belum terbukti sampai
Anda mencobanya sendiri.

## 13.2 Environment production

Tidak ada. Yang-production adalah:

- Konfigurasi: blok `config:` di `cordis.patch.yml` profil.
- Data: direktori `stateDir` di disk lokal.
- Rahasia: tidak ada. Plugin ini tidak punya API key, token, atau password apa pun.

Kalau Anda memasang plugin ini di mesin bersama, pastikan `stateDir` berada di lokasi yang
hanya dibaca user yang relevan, karena isinya berisi potongan output perintah dan cuplikan
dari kode Anda.

## 13.3 Upgrade

```bash
cd /path/ke/ds-context-optimizer
git pull
npm install --cache ./.npm-cache     # tambahkan --cache hanya kalau perlu
npm test                             # pastikan masih hijau di versi baru
```

Lalu minta operator me-restart profil. Kalau skema store berubah di versi baru, bersihkan dulu
dengan `ctx_purge` sebelum restart.

## 13.4 Uninstall

```bash
dsh plugin --profile web remove dsh-context-optimizer
```

Direktori state tidak ikut terhapus. Kosongkan dulu lewat `ctx_purge`, atau hapus manual setelah
profil berhenti.

## 13.5 Deployment otomatis

**Tidak ada.** Repo ini tidak punya `.github/`, tidak punya berkas pipeline, tidak punya
`Dockerfile`. Semua angka di README ini berasal dari menjalankan lokal. Kalau Anda fork repo ini,
menambahkan satu CI job yang menjalankan `npm run typecheck` dan `npm test` adalah tambahan
bernilai tertinggi berikutnya.

---

# 14. Security notes

## 14.1 Yang tidak boleh dilakukan

- **Jangan commit `.env`, API key, password, atau private key.** Repo ini kebetulan tidak
  butuh `.env`, tapi aturan ini tetap berlaku kalau nanti Anda menambahkannya. `.gitignore`
  saat ini mencakup `node_modules/`, `dist/`, `.npm-cache/`, `.tmp-ctxopt-*`, dan `*.sqlite*`.
- **Jangan pernah menempel token asli ke README, issue, atau log.** Contoh konfigurasi di
  dokumen ini memakai path dan nama host yang tidak bisa dipakai untuk produksi.
- **Jangan mengaktifkan `allowUnconfined: true`** tanpa menerima konsekuensinya. Itu membuat
  kode yang ditulis model berjalan tanpa batas file sama sekali.
- **Jangan set `denyPatterns` longgar.** Setiap entri adalah regex yang cocok ke teks perintah;
  regex yang terlalu longgar akan memblokir panggilan yang sah dan justru memberi pesan
  yang membingungkan.
- **Jangan mengindeks direktori berisi rahasia.** `ctx_index` membaca apa pun di dalam
  workspace dan menyimpannya di SQLite lokal. Kalau workspace Anda memuat `.env` atau kredensial,
  kecualikan segmen itu lewat `exclude`.

## 14.2 Apa yang sudah ditangani plugin ini

| Aspek | Bagaimana ditangani |
| --- | --- |
| Environment proses anak | Allowlist saja, bukan `process.env`. Terukur: anak hanya menerima `HOME LANG PATH PWD SHLVL _` |
| `HOME` proses anak | Diarahkan ke `scratchDir` (`/tmp`) supaya runtime yang punya kebiasaan cache tidak mengotori project |
| Path escaping | `realpath` lalu perbandingan kanonik, symlink di dalam project tidak bisa keluar |
| Path tidak ada | Ditolak, bukan diteruskan ke program |
| Fetch ke alamat internal | Ditolak sebelum socket terbuka, termasuk bentuk IPv4-mapped IPv6 |
| Redirect | Diperiksa ulang tiap hop, maksimal 5 hop |
| Skema URL | Hanya `http` dan `https` |
| Kredensial dalam URL | Ditolak |
| Batas ukuran output | stdout dan stderr berbatas dengan penanda truncasi |
| Batas waktu | Diterapkan per eksekusi, hasilnya exit 124 |
| Tidak ada backend sandbox | Panggilan menolak, bukan jatuh ke mode tanpa batas |
| Konfigurasi rusak | Plugin menonaktifkan dirinya dengan pesan, bukan melempar exception yang menjatuhkan profil |

## 14.3 Apa yang TIDAK dikonfigurasi, dan kenapa itu penting

- **Jaringan dan cakupan baca tidak dibatasi oleh sandbox.** Seam sandbox milik host adalah
  batas **efek file**. Tidak ada `--unshare-net` pada bubblewrap host ini, dan reads tidak
  dibatasi. Kode yang berjalan di bawah `workspace-write` bisa membaca berkas apa pun yang
  bisa dibaca user host dan bisa menjangkau jaringan; ia hanya tidak bisa menulis di luar
  workspace. Perlakukan `ctx_execute` dengan kewaspadaan yang sama seperti tool eksekusi kode
  apa pun.

  Kalau Anda butuh penolakan jaringan untuk kode yang dieksekusi, tambahkan di level host.

- **Gate routing bersifat advisory secara bawaan.** Penolakan butuh entri `denyPatterns`
  eksplisit. Plugin yang memblokir panggilan yang sebenarnya diizinkan host-nya sendiri akan
  menjadi jebakan, jadi ini pilihan sadar.

- **Version skew antara checkout DSH dan bundel profil** tidak diuji di luar cetakan versi
  seperti yang dijelaskan di [10.5](#105-version-skew).

- **`<pending_tasks>` di snapshot tidak punya sumber.** Section-nya ada di template, tapi
  tidak ada jalur kode yang mengategorikan `task`.

- **Tidak ada CI.** Tidak ada yang menjalankan test otomatis saat perubahan masuk.

Hal-hal berikut adalah **keputusan desain**, bukan keterbatasan, supaya tidak tertukar dengan
bug:

- **Pemotongan output menyimpan ekor, bukan kepala**, karena baris terakhir biasanya
  diagnostik yang Anda butuhkan. Bagian tengah yang dibuang ditandai `...[truncated]...`.
- **Backend sandbox di-resolve per panggilan**, jadi `ctx_doctor` selalu menggambarkan host
  sebagaimana adanya saat itu, bukan saat plugin dimuat.
- **`ctx_purge` membuang semua atau tidak sama sekali**, dan `confirm` harus `true`.

---

# 15. FAQ

**Apakah harus restart DSH setiap kali plugin berubah?**
Ya. Plugin dimuat saat profil boot. Setelah reinstall atau perubahan `cordis.patch.yml`,
profil harus di-restart, dan restart adalah tindakan operator.

**Apakah boleh memakai plugin ini tanpa `ctx_execute`?**
Boleh. `ctx_index`, `ctx_search`, `ctx_batch_execute`, `ctx_fetch_and_index`, `ctx_resume`,
`ctx_stats`, `ctx_doctor`, dan `ctx_purge` tidak menjalankan kode sama sekali. Hanya
`ctx_execute` dan `ctx_execute_file` yang menjalankannya.

**Apakah datanya terkirim ke internet?**
Tidak. Yang ada hanya dua berkas SQLite lokal. Akses jaringan hanya terjadi kalau model
memanggil `ctx_fetch_and_index` dengan URL.

**Kenapa output dipotong dari belakang, bukan dari depan?**
Desain. Baris terakhir biasanya pesan error yang Anda butuhkan. Penanda
`...[truncated]...` menunjukkan bagian tengah yang dibuang.

**Bisakah dipasang di beberapa profil?**
Bisa. Tapi kalau `stateDir` dibiarkan sama, semuanya menulis ke SQLite yang sama. Set
`stateDir` berbeda bila Anda mau isolasi.

**Apakah `ctx_search` bisa mencari Operator FTS5?**
Tidak. Teks query dipecah pada karakter non-alfanumerik lalu tiap term diapit tanda kutip
sebelum masuk ke FTS5, jadi query `foo-bar` atau `path/to` tetap aman.

**Kenapa `ctx_search` menemukan hal yang tidak saya cari?**
Tokenizer FTS5 memotong kata dan mener stemmed. Query panjang seperti
`zzz-token-yang-tidak-pernah-ada` menjadi enam term, dan satu pun yang muncul di dokumen lain
cukup untuk menghasilkan hit. Coco-kan query dengan isi output sebenarnya. Fenomena ini terukur
pada 2026-10-07.

**Kenapa `ctx_resume` menaruh hasil yang berhasil di `<recent_errors>`?**
Karena `tool/result` dipetakan ke kategori `error` tanpa memeriksa isi hasil. Perilaku ini
dokumentasikan di [7.7](#77-lanjutkan-sesi-ctx_resume). Kalau Anda butuh pemisahan sukses dan
gagal, itu perubahan pada `src/session/snapshot.ts`.

**Apakah ada HTTP API?**
Tidak. Plugin ini hanya mendaftarkan tool ke host. Tidak ada server, tidak ada port.

**Kenapa `npm install` gagal dengan `EROFS`?**
Folder home Anda read-only, dan npm ingin menulis cache di sana. Pakai
`npm install --cache ./.npm-cache`.

**Apa itu `CTX_REQUIRE_HOST`?**
Environment variable yang hanya dipakai test. `npm run test:host` menyetelnya supaya suite
host gagal tertutup kalau checkout DSH tidak ada, alih-alih melewati diam-diam.

**Bisakah dijalankan di Windows atau macOS?**
**Perlu dikonfirmasi.** Yang terukur hanya Linux dengan bubblewrap. Plugin tidak
mengimplementasikan sandbox-nya sendiri; ia meminta layanan sandbox host, jadi hasilnya
bergantung pada instalasi DSH Anda.

**Apakah aman untuk mesin produksi?**
Plugin menolak eksekusi tanpa backend sandbox dan tidak pernah menulis di luar `stateDir`.
Tapi remember: batasnya hanya efek file, jaringan dan baca tetap terbuka. Anda yang memutuskan.

---

# 16. Final checklist

Centang setiap baris sebelum menyatakan setup selesai.

**Mesin siap**

- [ ] `node --version` memberi v22.13 atau lebih baru
- [ ] `npm --version` bekerja
- [ ] `pnpm --version` bekerja (dibutuhkan untuk `dsh plugin ... add`)
- [ ] `dsh --version` bekerja
- [ ] `bwrap --version` bekerja (dibutuhkan hanya untuk `ctx_execute`)
- [ ] `ls "$DSH_HOME/profiles"` menampilkan profil yang mau dipakai

**Repo siap**

- [ ] `git clone` selesai dan `cd` sudah masuk ke folder repo
- [ ] `npm install` selesai tanpa error
- [ ] `npm run build` keluar dengan kode 0
- [ ] `npm test` melaporkan `fail 0` dan `echo $?` memberi 0
- [ ] Kalau hasil hijau karena suite host dilewati, Anda tahu itu dan sudah menyiapkan
      `DSH_HARNESS_HOME`

**Plugin terdaftar**

- [ ] `dsh plugin --profile <nama> add link:/path/absolut/ke/ds-context-optimizer` selesai
- [ ] `grep 'dsh-context-optimizer' "$DSH_HOME/profiles/<nama>/package.json` menemukan baris
      dependency **dan** kemunculan di `dsh.profile.bundles`
- [ ] `ls -la "$DSH_HOME/profiles/<nama>/node_modules/dsh-context-optimizer"` menunjukkan
      symlink ke repo
- [ ] `dsh --profile <nama> --dump-config | grep dsh-context-optimizer` menemukan baris loader

**Plugin hidup**

- [ ] Profil sudah di-restart oleh operator
- [ ] `ctx_doctor` menjawab `ok: true`
- [ ] `sandbox.available` dan `sandbox.enforced` bernilai `true`
- [ ] `runtimes` melaporkan bahasa yang memang Anda pakai sebagai `available`
- [ ] `errors` kosong
- [ ] `ctx_execute` dengan program sederhana keluar 0 dan menghasilkan stdout
- [ ] `ctx_index` lalu `ctx_search` mengembalikan hit
- [ ] `ctx_stats` menunjukkan `sources` dan `chunks` bukan nol setelah pengujian

**Kebersihan**

- [ ] Tidak ada berkas `.env`, `.sqlite`, atau `dist/` di `git status`
- [ ] `git status --porcelain` bersih atau hanya berisi perubahan yang memang Anda kerjakan

---

## Known issues dari audit (e2e dan source review)

Temuan terukur saat menulis dokumen ini. Semuanya terukur pada 2026-10-07, lewat panggilan tool
sungguhan pada profil `web` yang sedang berjalan.

1. **`tool/result` dipetakan ke kategori `error` tanpa memeriksa `ok`.** Section
   `<recent_errors>` di snapshot jadi memuat hasil yang sukses. Ini perilaku yang
   terdokumentasi (`README` versi lama, bagian "How the session snapshot works"), bukan
   kebetulan. Perubahan perilaku ini butuh keputusan: memisahkan sukses dan gagal di
   `src/session/snapshot.ts` mengubah bentuk snapshot yang sudah dibaca.
2. **Runtime bahasa yang tidak terpasang memunculkan pesan mentah bubblewrap.** Memanggil
   `ctx_execute` dengan `language: "go"` di mesin tanpa Go mengembalikan
   `ok: false`, `exitCode: 1`, `stderr: "bwrap: execvp go: No such file or directory"`.
   Plugin sudah punya probe runtime (`runtimeAvailable` di `src/runtime.ts:122`) tetapi hanya
   dipakai `ctx_doctor` dan unit test, tidak dipakai jalur eksekusi. Tidak ada kontrak tertulis
   yang dilanggar, jadi statusnya kosmetik, bukan cacat.
3. **`enforcement` tetap `full` ketika proses gagal mulai.** `src/executor.ts` menetapkan
   `enforcement` sebelum memanggil `spawn` dan tidak mengoreksinya kalau `execvp` gagal, jadi
   kasus di butir 2 melaporkan `enforcement: "full"` untuk proses yang tidak pernah jalan.
   Prinsip yang ditulis di komentar berkas itu sendiri (`src/executor.ts:115-119`) menyatakan
   tidak boleh mengklaim batas penuh untuk proses yang tidak ada; README hanya secara
   eksplisit menutup kasus signal yang sudah dibatalkan.
4. **Tidak ada CI.** Tidak ada `.github/` dan tidak ada konfigurasi pipeline di repo ini.
5. **Satu test dilewati secara sengaja.** `test/host/gate.test.mjs` dilewati pada `npm test`
   karena memang begitu rancangannya. Jalankan `npm run test:host` bila Anda ingin
   verifikasi gagal tertutup.

---

## License

MIT. Lihat [`LICENSE`](./LICENSE). Copyright (c) 2026 mulqizamzam.