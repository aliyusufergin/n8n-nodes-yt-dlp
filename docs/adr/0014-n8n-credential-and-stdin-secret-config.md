---
status: accepted
---

# Authentication secret'ları n8n credential ve stdin config sınırında kalır

İlk sürüm opsiyonel tek Authentication Credential içinde Netscape cookie içeriği, site username/password, video password ve proxy URL destekleyecek; keyfi header/token, browser-cookie import, kullanıcı cookie/netrc/config path'i, command tabanlı credential, OAuth/browser login, OTP/2FA ve client-certificate path'i desteklemeyecek ve ilişkili CLI seçeneklerini Arguments alanında reddedecek. Cookie içeriği istek workspace'inde exclusive-create `0600` dosyaya yazılacak; diğer secret'lar sabit `--ignore-config --config-locations -` argv'siyle açılan yt-dlp'ye Secret Config olarak stdin'den verilecek. Secret argv, environment, Result veya loglara konmayacak; serializer, redaction, worker credential çözümü ve cleanup gerçek queue-mode release kapısıdır.
