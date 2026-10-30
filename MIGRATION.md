# Migrasi SIMARSIP ke Cloudflare D1 dan R2

## Status

`worker.js` kini memakai binding Cloudflare D1 (`DB`) untuk metadata dan R2 (`FILES`) untuk objek berkas. Kontrak JSON `{ action, ..., token }` dan respons `{ success, data }` tetap dipertahankan agar frontend yang ada tetap kompatibel. File disimpan privat di R2; Worker memberikan tautan bertanda tangan yang kedaluwarsa setelah 1 jam.

**Belum ada data Firebase/Drive yang dipindahkan oleh perubahan kode ini.** Migrasi data harus dilakukan setelah binding tersedia dan ekspor sumber diperiksa. Jangan menghapus Firebase atau berkas Drive sebelum rekonsiliasi dan masa rollback selesai.

## Persiapan Cloudflare

1. Buat database D1 dan bucket R2 melalui Cloudflare Dashboard.
2. Jalankan isi `schema.sql` pada database D1.
3. Pasang binding Worker bernama `DB` ke database tersebut dan binding bernama `FILES` ke bucket R2.
4. Konfigurasikan secrets `SESSION_SECRET`, `TEACHER_USERNAME`, `TEACHER_PASSWORD`, `DEVELOPER_USERNAME`, `DEVELOPER_PASSWORD`; `DEVELOPER_NAME` opsional. Pertahankan nilai kredensial dan `SESSION_SECRET` yang sesuai agar sesi/hash akun lama tidak rusak.
5. Pastikan `SIMARSIP_API_URL` di frontend menunjuk ke Worker baru. Google/Firebase secrets tidak lagi dipakai oleh Worker hasil migrasi.

Tidak ada bucket yang dipublikasikan. GET file memakai URL HMAC bertenggat waktu yang dibuat Worker setelah endpoint data memeriksa sesi/peran. Tautan dapat diteruskan selama masih berlaku, jadi masa berlaku tetap dibatasi satu jam; jika tautan kadaluwarsa saat halaman masih terbuka, muat ulang halaman untuk memperoleh tautan baru.

## Pemetaan data

Semua record aplikasi disimpan pada tabel `records` dengan pasangan `(collection, id)`. `data` mempertahankan field JSON sumber; kolom `username`, `owner_role`, `class_name`, dan `task_id` adalah salinan untuk indeks dan pembatasan query. Nama koleksi: `students`, `archives`, `classifications`, `tasks`, `submissions`, `practice`, `quiz`, `journal`, `feedback`.

Pertahankan ID asli dan field relasi `username`, `tugasId`, serta `archiveId`. Pastikan `ownerRole` terisi: arsip tanpa pemilik siswa adalah `guru`, arsip dengan pemilik siswa adalah `siswa`; klasifikasi siswa harus memiliki `ownerRole: "siswa"` dan username, sedangkan klasifikasi guru `ownerRole: "guru"`. Worker memakai kolom pemilik terindeks untuk membaca data dengan pembatasan peran. Pertahankan juga `passwordHash` dan `passwordSalt` akun siswa apa adanya; jangan mengekspor password plaintext atau meng-hash ulang. Dokumen internal OAuth Google bukan data aplikasi dan tidak perlu diimpor. Arsipkan daftar file Drive beserta ID dan metadata sumber untuk proses salin ke R2.

## Cutover yang disarankan

1. Jadwalkan masa pemeliharaan singkat; hentikan penulisan dari aplikasi lama.
2. Buat ekspor Firestore yang dapat diulang, lalu validasi jumlah record per koleksi, ID unik, field akun, kepemilikan, kelas, dan relasi tugas/pengumpulan.
3. Impor JSON ke D1 dengan skrip migrasi terkontrol yang menggunakan kolom indeks sesuai isi JSON. Salin berkas Drive ke R2 menggunakan object key berprefix (folder di R2 adalah prefix, bukan direktori sungguhan), lalu perbarui `file` dalam record menjadi `{ name, key, type, size }`.
4. Jangan menyimpan URL Drive lama sebagai akses aktif. Untuk tiap berkas, verifikasi object key di R2 dan catat hasil salin; pastikan arsip tanpa file tetap valid.
5. Cocokkan jumlah serta sampel data, uji login guru/siswa/developer, hak akses lintas akun, tugas, arsip, preview/unduh, penggantian, dan penghapusan.
6. Alihkan URL API ke Worker baru. Pertahankan sumber lama hanya-baca untuk jangka rollback yang disepakati; hapus salinan lama setelah persetujuan dan backup.

Migrasi data lintas layanan tidak atomik: D1 dan R2 tidak berbagi transaksi. Penggantian file dilakukan dengan mengunggah objek baru, menyimpan metadata D1, lalu menghapus objek lama. Penghapusan record menghapus objek terkait dan metadata; lakukan backup sebelum cutover dan tinjau log jika layanan gagal di tengah proses.

## Struktur folder

R2 tidak memiliki folder Google Drive. Worker menata key dengan prefix berdasarkan peran, kelas, username, tahun, jenis, dan klasifikasi. Halaman aplikasi dapat menyajikan prefix tersebut sebagai penjelajah folder visual, tetapi bukan antarmuka Google Drive penuh atau folder fisik. Folder lama di Google Drive tidak ikut tersedia dari R2 setelah cutover.
