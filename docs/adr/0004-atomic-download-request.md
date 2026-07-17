---
status: accepted
---

# Her İndirme İsteği atomiktir

Node, `--abort-on-error` davranışını kontrol edecek; `--ignore-errors` ile `--no-abort-on-error` seçeneklerini kabul etmeyecek ve Artifact'leri ancak process başarıyla tamamlanıp tüm doğrulama ve limit kontrolleri geçtikten sonra n8n'e aktaracak. Playlist'in geç bir öğesinde hata olduğunda önceki indirmeleri de atmak maliyetli olsa da kısmi post-processing durumunu ve yarım sonuç sözleşmesini ortadan kaldırmak için istek içi kısmi başarı reddedildi.
