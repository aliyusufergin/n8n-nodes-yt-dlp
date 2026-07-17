---
status: accepted
---

# FFmpeg ve FFprobe tarih etiketli resmî yt-dlp GPL build'inden gelir

İlk sürüm Platform Paketi, `yt-dlp/FFmpeg-Builds` projesinin mutable `latest` asset'i yerine exact tarih etiketi, asset adı ve SHA-256 ile sabitlenmiş Linux x64 GPL static build'inden yalnızca `ffmpeg` ve `ffprobe` executable'larını dağıtacak. Platform paketi yayımlanmadan önce exact FFmpeg ve statik bağlı haricî kütüphane kaynakları, patch'ler, configure seçenekleri ve build/installation scriptlerini içeren Corresponding Source Bundle aynı GitHub release'inde yayımlanacak; npm belgeleri kalıcı exact bağlantıyı gösterecek ve otomatik manifest ile manuel lisans kontrolü tamamlanmazsa publish engellenecek. LGPL/minimal özel build ve upstream kaynağın gelecekte erişilebilir kalacağına dayanan source offer v1 kapsamında değildir.
