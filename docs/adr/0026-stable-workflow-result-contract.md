---
status: accepted
---

# Workflow output minimal ve kararlı bir Sonuç Sözleşmesi kullanır

İlk sürümün tek main output'u `status` alanıyla ayrılan iki exact item biçimi kullanacaktır. Artifact Item, bir tabanlı basename sırasındaki `artifactIndex`, `artifactCount`, doğrulanmış `fileName`, explicit `mimeType` ve artifact descriptor/stat sonucundan gelen `sizeBytes` JSON metadata'sını; sabit `binary.data` alanını ve `pairedItem: { item: inputIndex }` bağını taşır. Failure Item yalnız `Continue On Fail` için `status: "error"`, kararlı `errorCode`, kısa node-authored İngilizce `errorMessage` ve aynı input bağını taşır; binary içermez. V0.2.0 request hata kodları `INVALID_SOURCE_URL`, `INVALID_ARGUMENTS`, `YTDLP_FAILED`, `REQUEST_TIMEOUT`, `PROCESS_OUTPUT_LIMIT`, `RESOURCE_LIMIT`, `INVALID_ARTIFACT_SET` ve `BINARY_TRANSFER_FAILED` olarak dondurulur; yalnız bilinen typed İstek Hataları Failure Item olabilir. Helper'a full path yerine doğrulanmış basename ve bağımlılıksız sürümlenmiş extension tablosundan explicit MIME verilecek, bilinmeyen uzantı `application/octet-stream` olacaktır. URL, Arguments, credential/proxy değerleri, argv/environment, worker path'i, stack veya ham stdout/stderr hiçbir output biçimine konmayacak; cancellation, execution-geneli limitler, invariant/cleanup hataları ve bilinmeyen exceptions global kalacaktır.
