---
status: accepted
---

# JavaScript challenge'ları paketlenmiş Deno ile çözülür

İlk sürüm yalnızca Platform Paketi'nde sabitlenmiş Deno Challenge Runtime'ını mutlak yoldan kullanacak; runtime seçimi ve remote component seçenekleri node-controlled olacak, yt-dlp temizlenmiş minimal environment ile başlatılacak ve Node.js runtime desteklenmeyecek. Node'un remote component kontrolü yt-dlp'nin `--no-remote-components` seçeneğidir ve `ejs:github` ile `ejs:npm` kaynaklarını kapatır; Deno'nun kendi `--no-prompt`, `--no-remote` ve `--no-config` flag'leri node tarafından set edilmez, yt-dlp onları `DenoJCP._DENO_BASE_OPTIONS` içinde sabitler. yt-dlp 2026.06.09 Deno sağlayıcısı bu flag'lerle dosya sistemi, ağ, environment veya subprocess izni vermeden çalışırken Node sağlayıcısının izin modeli hedef Node 22/24 aralığında eşdeğer ağ izolasyonu sağlamadığından ek dağıtım maliyeti kabul edildi. Exact n8n Alpine image'da executable ve izin-denial E2E testi yayın kapısıdır.
