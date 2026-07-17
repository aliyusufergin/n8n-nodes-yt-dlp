---
status: accepted
---

# Her execution ve istek sabit bir Resource Envelope içinde çalışır

İlk sürüm node execution başına 20 input ve iki saat hard cap; istek başına varsayılan/hard olarak 30/60 dakika timeout, 20/50 Artifact, 128/256 MiB tek Artifact ve 256/512 MiB final toplam uygular. Playlist varsayılan olarak ilk beş entry ile sınırlanır ve explicit `-I` en fazla cardinality'si hesaplanabilen 20 entry seçebilir. Workspace saniyede en az bir ölçülüp yapılandırılmış final toplamın iki katı + 64 MiB'yi aşarsa process group sonlandırılır; FFmpeg thread ve yt-dlp fragment concurrency birde tutulur. Binary transferi dosya dosya sıralıdır; limitler yalnız hard cap'e kadar düşürülüp yükseltilebilir. Request limitleri İstek Hatası, execution input/süre ihlalleri global hatadır; container crash/SIGKILL sonrası kapasite ve cleanup operatör sınırında kalır.
