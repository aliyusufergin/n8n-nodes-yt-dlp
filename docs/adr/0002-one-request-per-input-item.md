---
status: accepted
---

# Her input item tek bir İndirme İsteği'dir

Node, URL'yi `Arguments` satırından ayıracak ve her input item için tam olarak bir URL ile bir yt-dlp çalıştırması kabul edecek; çoklu URL'ler birden fazla n8n item'ıyla ifade edilecek, playlist ise tek URL'li bir istek olarak kalacak. Bu sınır tam terminal satırı esnekliğinden vazgeçir, ancak option değerleriyle positional URL'leri ayırır ve artifact, hata, timeout ile item-linking sahipliğini tek bir input item'a bağlar.
