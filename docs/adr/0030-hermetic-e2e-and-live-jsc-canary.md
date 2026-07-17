---
status: accepted
---

# Release testi hermetik E2E ve canlı JSC canary olmak üzere iki katmanlıdır

Release Candidate Zinciri'nin birincil ve bloklayıcı kabul kanıtı, ADR 0025'teki her n8n anchor'ında exact yayımlanmış tarball'ları Community Packages üzerinden kuran gerçek queue-mode E2E olacaktır. Workflow çalışırken dış egress kapalı tutulacak; lisansı ve digest'i kayıtlı proje üretimi sentetik fixture'lar ile disposable origin ve authenticated proxy doğrudan indirme, FFmpeg/FFprobe, playlist ve çoklu Artifact, subtitle/thumbnail, cookie/proxy, progress suppression, timeout/cancellation, resource limitleri, binary round-trip, worker propagation/recreation ve cleanup sözleşmelerini sınayacaktır. Generic extractor davranışı kontrollü prototiple kanıtlanana kadar doğrulanmış sayılmaz.

Ayrı bir bloklayıcı fakat yeniden denenebilir canlı extractor/JSC canary, RC kesiminde isolated disposable CI runner'da credential ve medya indirmesi olmadan frozen yt-dlp/EJS/Deno zincirinin extraction yaptığını ve Deno challenge provider'ını gerçekten kullandığını kanıtlayacaktır. Ağ kesintisi veya rate limit `inconclusive` sayılır; pass değildir ve temiz geçiş olmadan `latest` terfisi yapılmaz. Toolchain build gate ayrıca frozen upstream EJS challenge-vector testlerini packaged Deno/EJS girdilerine karşı çalıştırır. Canlı canary supported-site garantisi değildir; yalnız kaydedilmiş URL/test kimliği, exact sürümler, bölge, zaman ve redakte bounded kanıtla tek yolun o anda çalıştığını gösterir. Exact fixture biçimleri, canlı kimlik, retry penceresi ve kanıt string'i kontrollü prototip ve hukuki değerlendirme tamamlanana kadar doğrulanmamıştır.
