---
status: accepted
---

# Continue On Fail yalnızca İstek Hataları'nı dönüştürür

Node, URL/argüman doğrulama, yt-dlp non-zero exit, istek timeout'u ve artifact limit ihlalini item bazlı İstek Hatası olarak ele alacak; `Continue On Fail` kapalıyken item index'li `NodeOperationError` fırlatacak, açıkken binary içermeyen, kaynak input'a bağlı ve redakte edilmiş tek bir Failure Item döndürecek. Workflow cancellation'ı ve eksik/bozuk packaged executable gibi node-geneli invariant ihlalleri devam edilebilir olmadığından bu davranışı atlayıp tüm çalıştırmayı durduracak.
