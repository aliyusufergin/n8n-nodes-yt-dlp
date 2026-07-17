---
status: accepted
---

# Her Artifact ayrı bir output item'dır

Node, playlist ve yan dosyalar dâhil her fiziksel Artifact'i sabit `data` binary alanına sahip ayrı bir output item olarak döndürecek; item kaynak input'a bağlanacak, yalnızca kompakt dosya metadata'sı taşıyacak ve ayrı bir summary item üretilmeyecek. Tek item'da dinamik sayıda binary alan toplamak playlist boyutuyla büyüyen, downstream kullanımı ve limitleri belirsiz bir sözleşme yaratacağı için Artifact başına item modeli seçildi.
