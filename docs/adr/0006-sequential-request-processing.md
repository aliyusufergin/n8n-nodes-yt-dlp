---
status: accepted
---

# İndirme İstekleri sıralı işlenir

Bir node execution aynı anda en fazla bir yt-dlp process çalıştıracak ve input item'larını sıralı işleyecek; ilk sürüm node-level concurrency ayarı sunmayacak. n8n worker'ın zaten birden fazla workflow job'ı paralel çalıştırması nedeniyle item-level paralellik process ve FFmpeg tüketimini çarpan etkisiyle büyütürür; daha düşük tek-workflow gecikmesi yerine öngörülebilir kaynak kullanımı ve kararlı output sırası tercih edildi.
