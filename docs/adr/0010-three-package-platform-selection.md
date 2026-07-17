---
status: accepted
---

# Platform executable'ları üç paketli topolojiyle seçilir

`n8n-nodes-yt-dlp@0.2.0`, exact normal dependency olarak `n8n-nodes-yt-dlp-platform@0.2.0` Platform Selector'ünü kullanacak; selector da exact optional dependency olarak `n8n-nodes-yt-dlp-linux-x64@0.2.0` Platform Paketi'ni seçecek. n8n 2.27.4 installer'ı ana paketin doğrudan optional dependency'lerini npm çözümlemesinden önce sildiği için bu dolaylı yapı seçildi; hiçbir paket lifecycle script, runtime download, npm bin-link veya `PATH` keşfine dayanmayacak ve selector davranışı gerçek Community Packages E2E ile yayın kapısında kanıtlanacak.
