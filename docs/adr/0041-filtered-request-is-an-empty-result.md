---
status: accepted
---

# Filtrenin elediği istek başarılıdır ve çıktı üretmez

Güvenli Argüman Profili'ndeki bir filtre kaynağı elediği için hiçbir Artifact üretmeden tamamlanan İndirme İsteği başarılı sayılır ve hiçbir output item üretmez: ne Failure Item, ne boş bir Artifact Item. `INVALID_ARTIFACT_SET` bundan sonra yalnız tek bir anlama gelir — hiçbir filtre elemedi, yt-dlp sıfırla çıktı ve yine de hiçbir şey üretmedi. ADR 0036 bu kodu "gerçekten geçersiz bir Artifact seti" olarak yorumlarken sıfır Artifact üretmenin meşru bir yolu yoktu; V2'nin tarih filtreleri o varsayımı geçersiz kılar, çünkü "son bir haftada yüklenmemiş" bir kaynak için sıfır dosya hata değil, cevabın kendisidir.

ADR 0039 bu kararı zorunlu kılar. Genişletmeden sonra her entry kendi isteğidir, dolayısıyla 500 entry'lik bir playlist'e uygulanan tarih filtresi 495 çıktısız istek üretir. Eski sınıflandırmayla bunların her biri `INVALID_ARTIFACT_SET` olurdu ve `Continue On Fail` kapalıyken **ilk** elenen entry bütün node çalışmasını düşürürdü; yani filtre seçenekleri fiilen kullanılamaz olurdu.

Elenen istekler için satır üretilmemesi bilinçli bir alt karardır: 495 tane "burada bir şey yok" item'ı kullanıcının eşleşen beş videoyu bulmasını zorlaştırırdı ve `--date` yazan kullanıcı eşleşmeyenler için satır beklemiyor. Kaç isteğin bu şekilde sonuçlandığı ADR 0031'in Observability Sınırı'ndaki tek execution özetinde raporlanır. Bunun bedeli kayda geçer: filtresi yanlış yazılmış bir workflow ile hiçbir şeyin gerçekten eşleşmediği bir workflow, çıktı tarafında birbirinin aynı görünür — ikisi de boştur ve ayrım yalnız özet log'undan okunur.

Reddedilen alternatifler: filtreyi genişletme anında uygulayıp elenen entry'nin hiç istek doğurmaması doğru sonucu verirdi ama listelemenin entry başına tam metadata çekmesini gerektirirdi ve maliyeti kullanıcının beklemediği bir yere koyardı; tarih seçeneklerini allowlist'e hiç almamak sorunu çözmez, erteler — sözleşmedeki boşluk yerinde kalır ve sonraki her filtre seçeneği aynı duvara çarpar. ADR 0026'nın geri kalanı değişmez: alan kümesi, `status` semantiği, redaksiyon kuralları ve dondurulmuş request hata kodu vokabüleri aynıdır.
