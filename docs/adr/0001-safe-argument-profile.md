---
status: accepted
---

# Güvenli Argüman Profili

Node, genel amaçlı bir yt-dlp CLI wrapper'ı olmayacak; CLI benzeri kullanımı sıkı bir izinli seçenek kümesiyle sınırlayacak ve bilinmeyen, node-controlled veya process/filesystem sınırını aşan seçenekleri reddedecek. Tam CLI uyumu daha geniş esneklik sağlasa da shell kullanılmaması tek başına yt-dlp'nin haricî komut, plugin, config, self-update ve keyfî path yeteneklerini güvenli kılmadığı için güvenlik ve öngörülebilirlik tercih edildi.
