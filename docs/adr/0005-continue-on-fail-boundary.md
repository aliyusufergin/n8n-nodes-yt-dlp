---
status: accepted
---

# Continue On Fail yalnızca İstek Hataları'nı dönüştürür

Node, URL/argüman doğrulama, yt-dlp non-zero exit, istek timeout'u ve artifact limit ihlalini item bazlı İstek Hatası olarak ele alacak ve n8n'in üç değerli `onError` ayarına göre yönlendirecek: `stopWorkflow`'da item index'li `NodeOperationError` fırlatacak, `continueRegularOutput`'ta binary içermeyen, kaynak input'a bağlı ve redakte edilmiş tek bir Failure Item'ı regular output'a (`output(0)`) yazacak, `continueErrorOutput`'ta aynı Failure Item'ı n8n'in workflow seviyesinde eklediği error output'a (`output(1)`) yazacak. `continueErrorOutput` altında regular output yalnız Artifact Item taşır; böylece standart n8n hata dallanma idiom'u sessizce ölü kalmaz. Workflow cancellation'ı ve eksik/bozuk packaged executable gibi node-geneli invariant ihlalleri devam edilebilir olmadığından her üç `onError` değerinde de bu davranışı atlayıp tüm çalıştırmayı durduracak.
