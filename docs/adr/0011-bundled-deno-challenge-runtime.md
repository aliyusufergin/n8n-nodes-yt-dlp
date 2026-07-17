---
status: accepted
---

# JavaScript challenge'ları paketlenmiş Deno ile çözülür

İlk sürüm yalnızca Platform Paketi'nde sabitlenmiş Deno Challenge Runtime'ını mutlak yoldan kullanacak; runtime seçimi ve remote component seçenekleri node-controlled olacak, yt-dlp temizlenmiş minimal environment ile başlatılacak ve Node.js runtime desteklenmeyecek. yt-dlp 2026.06.09 Deno sağlayıcısı dosya sistemi, ağ, environment veya subprocess izni vermeden `--no-prompt`, `--no-remote` ve `--no-config` kullanırken Node sağlayıcısının izin modeli hedef Node 22/24 aralığında eşdeğer ağ izolasyonu sağlamadığından ek dağıtım maliyeti kabul edildi. Exact n8n Alpine image'da executable ve izin-denial E2E testi yayın kapısıdır.
