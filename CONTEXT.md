# yt-dlp Community Node

This context defines the language used for safe, predictable media acquisition through the n8n community node.

## Language

**Güvenli Argüman Profili**:
Workflow yazarının CLI benzeri bir satırla ifade ettiği, ancak yalnızca node'un desteklediği güvenli yt-dlp seçeneklerinden oluşan sözleşme. Haricî komut çalıştırabilen, operatörün yerel kaynaklarına erişebilen veya artifact sınırından çıkabilen yetenekleri kapsamaz.
_Avoid_: Ham CLI, serbest argüman satırı, tam terminal eşdeğerliği

**İndirme İsteği**:
Tam olarak bir URL ve ona uygulanacak Güvenli Argüman Profili'ni taşıyan tek bir n8n input item'ı. Playlist URL'si birden fazla dosya üretse de tek bir İndirme İsteği'dir.
_Avoid_: Komut, batch, çoklu URL satırı

**Atomik İndirme İsteği**:
Yalnızca yt-dlp başarıyla tamamlanıp bütün Artifact'leri doğrulandığında sonuç üreten İndirme İsteği. Herhangi bir hata, timeout, cancellation veya limit ihlalinde isteğin hiçbir Artifact'i yayımlanmaz.
_Avoid_: Kısmi playlist, yarım başarı, best-effort istek

**Artifact**:
Bir İndirme İsteği sonucunda üretilen ve n8n binary data olarak aktarılabilen dosya.
_Avoid_: Worker dosyası, yerel path, Result dosyası

**Artifact Item**:
Tam olarak bir Artifact'i `data` binary alanında, kompakt metadata ve kaynak İndirme İsteği bağıyla taşıyan output item.
_Avoid_: Artifact paketi, summary item, çoklu-binary item

**İstek Hatası**:
Tek bir İndirme İsteği'ni başarısız kılan ancak node'un diğer input item'larını işlemesini zorunlu olarak engellemeyen doğrulama, yt-dlp, timeout veya limit hatası.
_Avoid_: Node arızası, cancellation, kısmi başarı

**Failure Item**:
`Continue On Fail` açıkken bir İstek Hatası'nı kararlı hata kodu ve redakte edilmiş mesajla temsil eden, binary içermeyen ve kaynak input'a bağlı output item.
_Avoid_: Artifact Item, ham stderr, hata dump'ı

**Uyumluluk Hedefi**:
Paketin çalışması amaçlanan, fakat her sürümü için doğrulanmış destek garantisi vermeyen host n8n sürüm aralığı. İlk yayının Uyumluluk Hedefi tüm n8n 2.x sürümleridir.
_Avoid_: Destek garantisi, test edilmiş aralık

**Doğrulanmış Destek**:
Tanımlı Community Packages ve E2E kabul testlerini geçmiş exact n8n sürümlerinin listesi.
_Avoid_: Tüm 2.x, beklenen uyumluluk, varsayılan destek

**Platform Selector**:
Ana paketin normal dependency olarak kullandığı, iç içe optional dependency üzerinden uygun Platform Paketi'ni seçen ve executable konumlarını sunan npm paketi.
_Avoid_: Binary downloader, installer script, platform paketi

**Platform Paketi**:
Tek bir desteklenen OS/CPU/libc bileşimi için sabitlenmiş yt-dlp, FFmpeg, FFprobe, Deno ve companion asset'lerini yayın tarball'ında taşıyan npm paketi.
_Avoid_: Platform Selector, runtime downloader, sistem dependency'si

**Challenge Runtime**:
Platform Paketi'ndeki mutlak yolundan çağrılan, yt-dlp'nin JavaScript challenge çözümünü dosya sistemi, ağ, environment veya subprocess izni olmadan çalıştıran sabitlenmiş Deno executable'ı. İlk sürümde başka JavaScript runtime desteklenmez.
_Avoid_: Sistem Node.js'i, PATH runtime'ı, kullanıcı seçilebilir runtime

**Corresponding Source Bundle**:
Dağıtılan GPL FFmpeg/FFprobe binary'lerinin üretildiği exact FFmpeg ve statik bağlı haricî kütüphane kaynaklarını, patch'leri, configure seçeneklerini ve build/installation scriptlerini birlikte taşıyan sürüme özgü kaynak arşivi.
_Avoid_: Upstream linki, yalnızca FFmpeg kaynak tarball'ı, source offer

**Toolchain Lock**:
Bir Platform Paketi sürümündeki yt-dlp, FFmpeg/FFprobe, Deno ve companion asset'lerinin exact upstream tag/commit, asset adı, SHA-256, lisans ve source-bundle kimliklerini tek yerde sabitleyen sürümlenmiş manifest.
_Avoid_: latest, release channel pointer, runtime update

**Authentication Credential**:
Workflow JSON'unda yalnızca n8n credential referansı görünen; Netscape cookie içeriği, site username/password, video password ve proxy URL'den oluşabilen opsiyonel `YT-DLP Authentication` credential'ı.
_Avoid_: Arguments secret'ı, keyfi header/token, browser cookie import

**Secret Config**:
Node'un desteklenen Authentication Credential değerlerini argv veya environment'a koymadan, sabit option adları ve doğrulanmış shlex serializer ile yt-dlp'nin explicit stdin config girişine aktardığı tek kullanımlık içerik.
_Avoid_: Kullanıcı config'i, config path'i, environment secret'ı

**Source URL**:
Bir İndirme İsteği'nin Arguments alanından ayrı tutulan, mutlak ve userinfo içermeyen `http:` veya `https:` URL'si.
_Avoid_: Search prefix, local URL, batch input, Arguments URL'si

**Network Trust Boundary**:
Node'un Source URL şemasını ve yapısını doğruladığı, ancak extractor redirect'leri, DNS sonuçları, manifest/media uçları veya FFmpeg bağlantıları için SSRF izolasyonu vaat etmediği sınır. Güvenilmeyen URL girdileri operatör egress kontrolü gerektirir.
_Avoid_: Public-IP garantisi, uygulama içi SSRF firewall

**Arguments Grammar**:
Arguments alanını whitespace, tek/çift quote, backslash escape ve bitişik parça birleştirmesiyle argv token'larına çeviren; expansion, comment, shell operatorü, positional veya URL kabul etmeyen bağımlılıksız sözdizimi.
_Avoid_: POSIX shell, shell-quote, string-argv, command line execution

**V1 Argument Allowlist**:
Yalnızca format seçimi, sınırlı playlist seçimi ve paketlenmiş FFmpeg ile media/subtitle/thumbnail işlemlerine ait exact yt-dlp seçeneklerini kabul eden fail-closed option şeması.
_Avoid_: CLI passthrough, güvenli görünen unknown option, blacklist

**Artifact Directory**:
Bir İndirme İsteği workspace'inde yalnızca final, tek-seviye ve doğrulanmış regular file'ların bulunmasına izin verilen `artifacts/` dizini.
_Avoid_: Output path, recursive output tree, temp dizini

**Resource Envelope**:
Bir node execution ve İndirme İsteği için input/playlist/artifact sayısı, dosya/toplam/workspace boyutu, süre, FFmpeg thread'i ve fragment concurrency üzerinde uygulanan varsayılan ve yükseltilemez hard cap'ler.
_Avoid_: yt-dlp resource flag'i, operatör kapasite garantisi, sınırsız playlist

**Process Group**:
Linux'ta detached yt-dlp lideri ile onun FFmpeg ve Deno descendants'ından oluşan, cancellation/timeout/limit halinde tek termination state machine tarafından birlikte sinyallenen process grubu.
_Avoid_: Yalnız child PID, shell process'i, unref child

**Bounded Process Output**:
stdout/stderr'i sürekli drain eden, yalnız sınırlı redakte tail tutan ve toplam üretilen byte hard cap'i aşıldığında Process Group'u sonlandıran çıktı sözleşmesi.
_Avoid_: Result log'u, sınırsız capture, progress geçmişi

**Binary Aktarım Sınırı**:
Doğrulanmış Artifact dosyalarının public n8n binary helper ile sıralı olarak storage backend'e yazıldığı sınır. Atomik İndirme İsteği workflow output'unda atomiktir; çoklu Artifact backend yazımları transaction veya anlık rollback garantisi taşımaz.
_Avoid_: Storage transaction'ı, internal n8n silme API'si, filesystem paylaşımı

**Execution Workspace**:
Worker-local temp alanında tek node execution için oluşturulan, heartbeat marker'ı taşıyan ve İndirme İsteği workspace'lerini kapsayan sahipli dizin. Normal akışta `finally` ile, yakalanamayan çöküşten sonra yalnız doğrulanmış stale sweep veya hedefli container recreation ile temizlenir.
_Avoid_: Paylaşılan `.n8n` volume'u, kalıcı download dizini, genel temp prune

**Release Candidate Zinciri**:
Platform Paketi, Platform Selector ve ana paketin aynı exact sürümle önce `next` altında ve dependency sırasıyla yayımlandığı; doğrulanmış E2E sonrasında main `latest` en son olacak biçimde terfi ettirildiği üç paketli yayın birimi.
_Avoid_: Main-first publish, doğrudan latest, bağımsız paket sürümü

**Bootstrap Publish**:
Henüz mevcut paket gerektiren Trusted Publisher ve staged publishing kullanılamadığı için yalnız `0.2.0` Release Candidate Zinciri'nde uygulanan, korumalı GitHub Environment içindeki kısa ömürlü granular token ile provenance üreten tek seferlik doğrudan `next` yayını.
_Avoid_: Kalıcı npm token'ı, provenance'sız ilk yayın, tekrarlanan bootstrap

**Lisans Yüzeyi**:
Bir npm tarball'ının `license` metadata'sı, component eşlemesi, verbatim lisans/notice dosyaları ve Corresponding Source yönlendirmesinden oluşan, alıcının her dağıtılmış bileşenin koşullarını doğrudan görebildiği yayın sözleşmesi.
_Avoid_: Paketin tamamı MIT iddiası, yalnız upstream linki, eksik notice

**Source Delivery Gate**:
GPL binary içeren Platform Paketi yayımlanmadan önce exact Corresponding Source Bundle'ın versioned GitHub Release'te doğrudan erişilebilir olmasını; digest, component/envanter, temiz rebuild ve manuel lisans incelemesinin geçmesini zorunlu kılan release engeli.
_Avoid_: Sonradan source ekleme, source-on-request, mutable downloader

**Release Gate Matrix**:
Bir Release Candidate Zinciri'nin `latest` olabilmesi için 2.x floor, gerçek kabul sürümü ve RC kesiminde dondurulan en yeni stable n8n sürümünün exact official Linux x64 image digest'lerinde çalıştırılan queue-mode E2E kümesi.
_Avoid_: Yalnız latest testi, mutable image tag'i, tüm 2.x test edildi iddiası

**İki Katmanlı Release Test Gate**:
Yayımlanmış exact tarball'ların dış ağ kapalı sentetik queue-mode E2E'sini, frozen yt-dlp/EJS/Deno zincirinin credential ve medya indirmesiz canlı extractor canary'siyle tamamlayan yayın engeli. Hermetik katman node ve queue sözleşmesini; canlı katman yalnız kaydedilmiş zamanda tek extractor/challenge yolunu kanıtlar. Dış servis kesintisi `inconclusive` olur ve temiz geçiş olmadan `latest` terfisi yapılmaz.
_Avoid_: Yalnız canlı site testi, yalnız direct-file fixture, supported-site garantisi

**Sonuç Sözleşmesi**:
Tek main output'ta `status` ile ayrılan, her Artifact için minimal ve kaynak input'a bağlı Artifact Item ya da yalnız `Continue On Fail` için kararlı request hata kodlu Failure Item üreten workflow-visible sözleşme. Binary metadata doğrulanmış basename, explicit MIME ve stat boyutundan gelir; input, secret, process çıktısı ve worker path'i output'a kopyalanmaz.
_Avoid_: Ham yt-dlp sonucu, log item'ı, input echo, helper'a özgü metadata sözleşmesi

**AI Tool Sınırı**:
Binary Artifact'i Agent response'una taşımayan n8n normal-node tool adapter'ı nedeniyle node'un `usableAsTool` ilan edilmediği v0.2.0 kapsam sınırı. AI üretimi değerler ordinary workflow bağlantılarıyla açıkça eşlenebilir; doğrudan Agent tool çağrısı desteklenmez.
_Avoid_: Metadata-only başarı, gizli binary drop, AI-safe node iddiası

**Platform Gate**:
V0.2.0 paketlerinin Linux x64 npm metadata'sı ile erken seçim yaptığı ve selector'ın platform, exact paket, manifest/digest ve executable probe'larını spawn öncesi yeniden doğruladığı fail-closed sınır. Resmî n8n Docker Linux x64 dışındaki ortamlar destek iddiası taşımaz ve sistem aracı fallback'i yoktur.
_Avoid_: PATH fallback, libc ile image kimliği, best-effort platform seçimi

**Toolchain Attestation**:
Her main/worker process'inde ilk kullanımda Platform Paketi manifestini ve execution dosyalarını descriptor, SHA-256, mode/path ve ağsız version probe'larıyla doğrulayan; başarıyı file fingerprint'leriyle cache'leyip her istek öncesi ucuz değişiklik kontrolü yapan fail-closed runtime doğrulaması.
_Avoid_: Her request full hash, publish-only güven, self-healing toolchain

**Observability Sınırı**:
Node'un n8n public logger üzerinden yalnız bounded ve secret-safe terminal request event'leri ile tek execution özeti ürettiği; özel HTTP/metrics endpoint'i veya telemetry exporter başlatmadığı sınır. n8n worker readiness yalnız DB/Redis readiness'idir; Toolchain Attestation veya node kapasitesi kanıtı değildir. Queue, container ve storage kapasite izlemesi operatöre aittir.
_Avoid_: Progress log'u, user-input label'ı, node-owned metrics server, healthz toolchain garantisi

**Release Definition**:
Aynı immutable üç npm paketinin `next` altında gerçek Community Packages kurulumu, üç-anchor disposable release matrix'i, temiz canlı JSC canary, ayrıca açıkça onaylanmış dar gerçek kabul-stack E2E'si ve tüm security, process, supply-chain, lisans, source-delivery ve dokümantasyon gate'leri geçmeden `latest` olamadığı v0.2.0 başarı sözleşmesi.
_Avoid_: Local pack kanıtı, tek happy-path download, CI-only kabul, kısmi gate feragati
