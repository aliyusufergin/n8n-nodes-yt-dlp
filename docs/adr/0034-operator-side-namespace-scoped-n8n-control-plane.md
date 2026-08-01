---
status: accepted
---

# n8n MCP operatör-yanı kalır ve agent yetkisi repo-kapsamlı namespace ile sınırlanır

Resmî n8n MCP bu repository'de yalnız operatör-yanı bir agent operasyon yüzeyidir: `nodes/`, `credentials/`,
`test/`, `e2e/`, `scripts/` ve GitHub Actions MCP'ye bağlanmaz, endpoint veya credential referansı taşımaz ve
yayımlanan npm paketleri MCP'ye runtime bağımlılığı kurmaz. ADR 0025, 0030 ve 0032'nin hermetik gate'leri
değişmeden kalır; MCP kanıtı yalnız ADR 0032'nin açıkça onaylanmış dar gerçek kabul lane'ini besler ve tek
başına `latest` terfisi üretmez. CI'ın da MCP kullanması ve bazı hermetik koşuların canlı instance eşdeğeriyle
ikame edilmesi değerlendirildi; ikisi de gate'leri canlı bir instance'a, orada saklanan credential'lara ve
mutable bir deployment kimliğine bağladığı için reddedildi.

Hedef instance'ta team project lisanslı değildir, dolayısıyla agent kaynakları ile operatörün üretim
workflow'ları tek personal project'i paylaşır ve project-level izolasyon mümkün değildir. Bu nedenle sahiplik
kaynağın kendisinde taşınır ve repo-kapsamlıdır: bir workflow ancak `agent/n8n-nodes-yt-dlp/…` ad öneki,
`agent:n8n-nodes-yt-dlp` tag'i ve `agent-owned/n8n-nodes-yt-dlp` folder'ının üçü birden slug'ı taşıdığında
agent-owned sayılır; Data Table'lar tag ve folder yüzeyi taşımadığı için yalnız ad kalıbıyla işaretlenir.
İşaretin repo slug'ı taşıması zorunludur, çünkü generic bir `agent-owned` sözleşmesi başka bir repository'nin
agent'ının kaynağını bu agent'a kendi kutusu gibi gösterirdi. Kısmi eşleşme fail-closed'dır: eksik işaret
sessizce tamamlanmaz, mutation yapılmaz, kalan exact state raporlanır. Bu işaret kümesi kaynak adlarına ve
folder düzenine yazıldığı için sonradan değiştirilmesi mevcut bütün agent kaynaklarının taşınmasını gerektirir.

Bu sınır içinde agent publish ve execute dâhil serbesttir; sınır dışında hiçbir mutation yapamaz — çalıştırma
da buna dâhildir, çünkü bir execution okuma değil gerçek yan etkidir. Serbestliğin bedeli yaşam döngüsü
kuralıyla ödenir: oturum sonunda agent'ın publish ettiği her workflow unpublish edilir, böylece gözetimsiz
webhook veya schedule kalmaz; workflow gövdesi lane kapanana kadar durur. Credential yüzeyi MCP'de yalnız
listeleme olduğundan credential'lar yapısal olarak operatör-sahiplidir ve agent yalnız operatörün o oturumda
adını verdiği credential ID'sini bağlar. Namespace dışı okuma bilinçli olarak serbest bırakılmıştır; koruma
okuma tarafında değil çıktı tarafındadır: operatör kaynağından okunan hiçbir şey repoya, issue yorumuna veya
yayımlanan bir artifact'e kopyalanmaz.
