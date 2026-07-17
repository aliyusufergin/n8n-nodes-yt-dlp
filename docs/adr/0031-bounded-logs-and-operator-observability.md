---
status: accepted
---

# Observability bounded node logları ile operatör altyapı izlemesine ayrılır

V0.2.0 node-owned HTTP server, Prometheus endpoint, background reporter veya telemetry exporter başlatmayacak; yalnız n8n'in public logger'ını ve Sonuç Sözleşmesi'ni kullanacaktır. Her İndirme İsteği tam olarak bir terminal event üretir: başarı `debug`, beklenen İstek Hatası `warn`, global invariant hatası `error`; cancellation ayrı outcome'dur. Her execution ayrıca tek `info` özeti üretir. Stable metadata event schema ve package/toolchain sürümü, execution ID, sıfır tabanlı input index, outcome/error code, süre, Artifact sayısı ve final byte toplamıyla sınırlıdır. Source URL, Arguments, filename/title/extractor, credential/proxy/header/cookie, argv/environment, stdout/stderr, worker path, stack ve progress loglanmaz.

Operatör runbook'u n8n main/worker health, queue active/waiting/failed eğilimleri, worker/container CPU ve RSS, worker writable-layer/temp boş alanı, Postgres/Redis sağlığı ile binary storage/database büyümesini izlemeyi zorunlu kılar. Universal alarm eşikleri veya güvenli worker topolojisi kod varsayımı değildir; frozen official image ve gerçek kabul topolojisindeki ADR 0019 load testi tamamlanana kadar doğrulanmamıştır. `/healthz/readiness` yalnız belgelenmiş DB/Redis readiness'idir ve Toolchain Attestation ya da Community Package readiness garantisi olarak sunulmaz; release gate her worker'ı gerçek node execution ile doğrular.
