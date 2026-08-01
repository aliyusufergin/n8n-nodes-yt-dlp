---
status: accepted
---

# n8n 2.x hedefi üç exact anchor Release Gate Matrix ile doğrulanır

Uyumluluk Hedefi `>=2 <3` kalır; `0.2.0` Doğrulanmış Destek listesi exact official Linux amd64 digest'leriyle n8n 2.0.0 floor, RC kesiminde o zamanki gerçek deployment'tan dondurulan tarihsel 2.27.4 matrix anchor ve kesimdeki en yeni stable 2.x release head'i içerir; 2026-07-17 araştırma anındaki head 2.30.7'dir. Her anchor Postgres, Redis, main, bir worker, queue mode, database binary storage, manual offload ve production execution ile explicit-version Community Packages install/propagation/loading, packaged toolchain, artifact round-trip, limit, cancellation ve cleanup testlerini geçer. Frozen head ayrıca iki worker, worker recreate ve late-worker exact-version recovery/readiness lane'ini geçer. Kimliği en yeni kabul kararıyla sabitlenen gerçek kabul sunucusundaki state-changing E2E bu disposable matrix'ten ayrıdır ve ayrı plan ile açık onay gerektirir. RC kesiminden sonra çıkan n8n sürümü matrix için “doğrulanmadı” olarak kaydedilir ve sonraki node release'inde head ilerletilir. Herhangi bir anchor failure'ı `latest` terfisini engeller; 2.x Uyumluluk Hedefi sessizce daraltılmaz. Üç anchor bütün ara 2.x patch'lerinin test edildiği anlamına gelmez ve dokümantasyon bunu açıkça ayırır.
