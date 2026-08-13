---
status: accepted
---

# Continue On Fail yalnızca İstek Hataları'nı dönüştürür

Node, URL/argüman doğrulama, yt-dlp non-zero exit, istek timeout'u ve artifact limit ihlalini item bazlı İstek Hatası olarak ele alacak; `stopWorkflow`'da item index'li `NodeOperationError` fırlatacak, `continueRegularOutput` ve `continueErrorOutput`'ta binary içermeyen, kaynak input'a bağlı ve redakte edilmiş tek bir Failure Item'ı tek main output'a yazacak. Error output node'un değil engine'in: `continueErrorOutput` altında n8n `handleNodeErrorOutput` ile son main output'u kendi tanıdığı hata item'larıyla (`item.error`, ya da yalnız `error` veya yalnız `error`+`message` alanlı `item.json`) **üzerine yazar**, dolayısıyla node oraya yazamaz ve üç alanlı Failure Item hiçbir zaman tanınmaz. Bu yüzden node `continueErrorOutput` seçildiğinde tek output davranışını korur ve `addExecutionHints` ile error output'un boş kalacağını, dallanmanın `$json.status` üzerinden yapılması gerektiğini uyarır; ölü dal sessiz değil görünür olur. Workflow cancellation'ı ve eksik/bozuk packaged executable gibi node-geneli invariant ihlalleri devam edilebilir olmadığından her üç `onError` değerinde de bu davranışı atlayıp tüm çalıştırmayı durduracak.
