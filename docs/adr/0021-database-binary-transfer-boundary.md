---
status: accepted
---

# V1 database binary storage ve output-atomic aktarım sınırı kullanır

İlk sürümün Doğrulanmış Destek kapsamı queue mode ile `database` binary storage'dır; queue mode `filesystem` desteklenmez ve S3 lisanslı exact-version E2E yapılana kadar doğrulanmamıştır. Bütün final dosyalar doğrulandıktan sonra Artifact'ler yalnız public `prepareBinaryData()` helper'ına stream verilerek sırayla aktarılır; internal n8n storage veya silme servisleri kullanılmaz. N'inci aktarım başarısızsa o İndirme İsteği hiçbir Artifact Item üretmez; `Continue On Fail` açıksa `BINARY_TRANSFER_FAILED` Failure Item üretip sonraki input'a geçer, değilse node execution başarısız olur. Public API çoklu yazım transaction'ı veya rollback sunmadığından daha önce yazılmış fakat referanslanmamış backend kayıtları execution hard-delete/pruning işlemine kadar kalabilir; bu sınır dokümante edilir ve N'inci aktarım hatası ile pruning temizliği exact-image queue-mode E2E'de doğrulanır.
