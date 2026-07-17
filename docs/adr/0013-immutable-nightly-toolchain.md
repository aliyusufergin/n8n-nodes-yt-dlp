---
status: accepted
---

# Toolchain exact doğrulanmış nightly snapshot'larla güncellenir

Her Platform Paketi bir Toolchain Lock ile yt-dlp exact nightly tag'ini ve yt-dlp, FFmpeg/FFprobe, Deno ile companion asset'lerinin tag/commit, asset adı, SHA-256, lisans ve source-bundle kimliklerini sabitleyecek. Runtime self-update, update channel geçişi, mutable `latest`, PATH fallback ve runtime component download yasaktır. Herhangi bir toolchain girdisi değiştiğinde üç npm paketi aynı yeni exact sürümle ve tüm lisans, exact-image, Community Packages ve queue-mode kapılarından sonra yayımlanacak; otomatik takvim olmayacak, yayımlanmış npm sürümü yeniden üretilmeyecek ve rollback doğrulanmış sürüme dist-tag dönüşü ile yapılacaktır.
