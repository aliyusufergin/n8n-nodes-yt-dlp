---
status: accepted
---

# Her execution ve istek sabit bir Resource Envelope içinde çalışır

İlk sürüm node execution başına 20 input ve iki saat hard cap; istek başına varsayılan/hard olarak 30/60 dakika timeout, 20/50 Artifact, 128/256 MiB tek Artifact ve 256/512 MiB final toplam uygular. Playlist varsayılan olarak ilk beş entry ile sınırlanır ve explicit `-I` en fazla cardinality'si hesaplanabilen 20 entry seçebilir. Workspace saniyede en az bir ölçülüp yapılandırılmış final toplamın iki katı + 128 MiB toolchain runtime tabanı + 64 MiB request headroom'unu aşarsa process group sonlandırılır. Toolchain tabanı ayrı bir terimdir: workspace aynı zamanda child process'in `TMPDIR`/`HOME`'udur ve paketlenmiş yt-dlp, PyInstaller payload'ını (ölçülen ~76 MiB) oraya açar; bu sabit maliyet Artifact bütçesiyle ölçeklenmez, bu yüzden headroom'a katlanamaz ve kullanıcının Artifact bütçesine yazılamaz. Sabit taban pinlenmiş toolchain'e karşı testle doğrulanır; FFmpeg thread ve yt-dlp fragment concurrency birde tutulur. Binary transferi dosya dosya sıralıdır; limitler yalnız hard cap'e kadar düşürülüp yükseltilebilir. Request limitleri İstek Hatası, execution input/süre ihlalleri global hatadır; container crash/SIGKILL sonrası kapasite ve cleanup operatör sınırında kalır.
