---
status: accepted
---

# Child lifecycle Process Group ve bounded output ile yönetilir

İlk sürüm yt-dlp'yi mutlak executable/argv, `shell: false`, request workspace `cwd`, `detached: true`, bağlı stdio ve yalnız workspace locale/no-color/Deno-update değişkenlerinden oluşan environment allowlist ile başlatacak; parent environment kopyalanmayacaktır. n8n cancellation, request timeout veya resource/output limiti stdin'i kapatıp negative group PID'ye SIGTERM, beş saniye sonra gerekirse SIGKILL gönderecek; `close` ve stdio kapanmadan cleanup yapılmayacaktır. Her stream yalnız 64 KiB redakte tail tutacak, birleşik 8 MiB üretimde request sonlandırılacak, success output'unda log olmayacak ve Failure Item en fazla 4 KiB/20 satır taşıyacaktır. Cancellation Continue On Fail'a dönüşmeyecek; termination başarısızlığı global invariant hatasıdır.
