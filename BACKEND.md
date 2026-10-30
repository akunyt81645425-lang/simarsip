# SIMARSIP Worker — Cloudflare D1 + R2

`worker.js` menyediakan API JSON untuk login guru, siswa, dan developer; akun siswa; arsip; klasifikasi; tugas; pengumpulan; aktivitas; serta Pusat Sambatan. Metadata disimpan di D1 dan berkas disimpan sebagai objek privat di R2. Bentuk API frontend tetap `{ action, ..., token }` dan respons `{ success, data }` agar integrasi yang ada tidak perlu diganti sekaligus.

## Konfigurasi Worker

Buat database D1 dan bucket R2 di Cloudflare, lalu pasang binding Worker berikut:

| Binding | Jenis | Kegunaan |
| --- | --- | --- |
| `DB` | D1 database | Seluruh record aplikasi |
| `FILES` | R2 bucket | File arsip dan bahan tugas; jangan aktifkan akses publik bucket |

Jalankan `schema.sql` pada database D1 sebelum menerima trafik. Atur secrets/variables Worker:

| Nama | Jenis | Kegunaan |
| --- | --- | --- |
| `SESSION_SECRET` | Secret | Nilai acak panjang untuk menandatangani sesi dan URL file sementara |
| `TEACHER_USERNAME` | Secret | Username login guru |
| `TEACHER_PASSWORD` | Secret | Password login guru |
| `TEACHER_NAME` | Variable (opsional) | Nama tampilan guru |
| `DEVELOPER_USERNAME` | Secret | Username login developer |
| `DEVELOPER_PASSWORD` | Secret | Password login developer |
| `DEVELOPER_NAME` | Variable (opsional) | Nama tampilan developer |
| `FILE_LINK_TTL_SECONDS` | Variable (opsional) | Umur tautan file dalam detik, maksimal 3600; default 3600 |

Pastikan `SIMARSIP_API_URL` pada frontend menunjuk ke URL Worker ini. Worker versi ini tidak menggunakan Firebase, Firestore, Google Drive, OAuth Google, ataupun secrets Google lama. Pertahankan kredensial guru/developer dan `SESSION_SECRET` saat cutover jika nilai tersebut tetap dibutuhkan. Jangan mengubah `SESSION_SECRET` tanpa memperhitungkan sesi aktif dan tautan file sementara.

## D1

Skema awal berada di `schema.sql`. Tabel `records` mempertahankan payload JSON agar bentuk record lama tetap kompatibel, sekaligus mengindeks koleksi, pemilik, username, kelas, dan ID tugas. Nama koleksi yang digunakan: `students`, `archives`, `classifications`, `tasks`, `submissions`, `practice`, `quiz`, `journal`, dan `feedback`.

ID dokumen siswa adalah username huruf kecil. Pertahankan ID asli record lain serta relasi `username`, `tugasId`, dan `archiveId` saat impor. Password siswa disimpan sebagai `passwordHash` dan `passwordSalt` PBKDF2; salin kedua field itu apa adanya, jangan mengimpor password plaintext atau menghitung ulang hash.

## R2 dan akses file

Bucket harus tetap privat. Worker menyimpan key berprefix, misalnya `archives/guru/Tahun/Jenis/Kode-Klasifikasi/...` atau `archives/siswa/Kelas/Username/Tahun/...`; prefix adalah cara mengelompokkan objek, bukan direktori R2 sungguhan. Bahan tugas berada di bawah prefix `tasks/`.

Setelah endpoint API memeriksa sesi dan hak akses, Worker menambahkan URL file HMAC yang berlaku paling lama satu jam. Endpoint `GET /files/...` memverifikasi tanda tangan dan masa berlaku sebelum membaca objek dari R2. URL sementara dapat diteruskan selama masih berlaku, tetapi tidak memberikan akses permanen ke bucket. File saat ini dibatasi 5 MB dan frontend mengirim payload Base64; pengembangan berikutnya dapat menggantinya dengan unggahan streaming/presigned upload untuk efisiensi.

Penggantian file mengunggah objek baru, menyimpan metadata D1, lalu menghapus objek lama. Penghapusan arsip/tugas/akun membersihkan objek R2 terkait dan record D1. D1 dan R2 tidak berbagi transaksi; lakukan backup dan pantau log pada operasi lintas layanan.

## Migrasi data dari Firebase dan Google Drive

Pembuatan binding dan perubahan kode **tidak memindahkan data secara otomatis**. Gunakan panduan `MIGRATION.md` untuk ekspor, pemetaan, impor, pemeriksaan jumlah record, dan cutover terjadwal. Jangan menghapus Firebase/Drive sampai data D1/R2 lolos rekonsiliasi serta periode rollback selesai.

Saat mengimpor file, ubah metadata menjadi `{ name, key, type, size }` dan pastikan objek dengan key tersebut telah ada di R2. Arsip tanpa file harus tetap dipertahankan. Jaga field `ownerRole`, `username`, kelas, dan relasi record; field pemilik menentukan pembatasan akses.

## Endpoint

- Login dan sesi: `loginTeacher`, `loginStudent`, `loginDeveloper`, `validateSession`, `logout`.
- Akun: `getUsers`, `createStudent`, `bulkCreateStudents`, `updateStudent`, `deleteStudent`, `deleteStudents`.
- Arsip: `getArchives`, `getStudentArchives`, `createArchive`, `updateArchive`, `deleteArchive`, `createPracticeArchive`.
- Klasifikasi: `getClassifications`, `createClassification`, `deleteClassification`.
- Tugas dan pengumpulan: `getTasks`, `createTask`, `deleteTask`, `getSubmissions`, `createSubmission`, `updateSubmission`.
- Aktivitas dan pesan: `getPractice`, `getQuizResults`, `getJournals`, `saveQuizResult`, `saveJournal`, `getFeedback`, `createFeedback`, `getAllFeedback`, `replyFeedback`.
- Dasbor: `getDashboardTeacher`, `getDashboardStudent`.

Aksi akun, tugas, arsip resmi, dan inspeksi arsip siswa dibatasi untuk guru. Siswa hanya dapat mengelola data miliknya dan mengakses tugas untuk kelasnya. Developer hanya dapat melihat serta membalas Pusat Sambatan. Halaman Struktur Folder Arsip menyajikan penjelajah folder virtual berbasis metadata; R2 tidak menyediakan folder Drive atau antarmuka Google Drive yang persis sama.
