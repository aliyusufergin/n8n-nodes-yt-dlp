# FFmpeg 8.1.2 Corresponding Source araştırması

Bu not, platform paketlerine kopyalanan `ffmpeg` ve `ffprobe` ikilileri için
tam, çevrimdışı ve denetlenebilir bir Corresponding Source Bundle üretmenin
kaynak zincirini tanımlar. Hukuki görüş değildir; teknik olarak muhafazakâr
bir GPLv3 uyum stratejisidir.

## Sonuç

Bundle hazırlanabilir. Ancak yalnızca `wader/static-ffmpeg` Dockerfile'ındaki
üst düzey URL'leri indirmek yeterli değildir. Derleme sırasında ayrıca Alpine
statik kütüphaneleri, Meson fallback kaynakları, libjxl alt bağımlılıkları ve
Cargo registry kaynakları ikililere girmiştir.

Eksiksiz bundle şu dört şeyi aynı arşivde taşımalıdır:

1. İkilileri üreten tam build scriptleri ve bunların yerel değişiklikleri.
2. FFmpeg ile statik bağlanan bütün kütüphanelerin tercih edilen kaynak biçimi.
3. Alpine APKBUILD tarifleri, yamaları ve bu tariflerin doğruladığı distfile'lar.
4. Çevrimdışı build için gereken, build sırasında ağdan çekilmiş tüm transit
   kaynaklar.

GPLv3, Corresponding Source'u ikiliyi üretmek, kurmak, çalıştırmak ve
değiştirmek için gereken kaynak ile bu işlemleri yöneten scriptler olarak
tanımlar. Genel amaçlı ve eserde yer almayan araçları ve tanımlı System
Libraries'i dışarıda bırakır. Ağdan ikili sunuluyorsa kaynağa eşdeğer erişim
aynı yerden veya yanında açıkça gösterilen başka bir sunucudan sağlanmalı ve
dağıtım sürdüğü müddetçe erişilebilir tutulmalıdır
([GPLv3 §§1 ve 6](https://www.gnu.org/licenses/gpl-3.0.html#section1)).

Bu nedenle yalnız upstream bağlantıları veren bir `SOURCE_OFFER.md` yeterli
bir bundle değildir. Kaynak byte'ları release artifact olarak bizim
kontrolümüzde tutulmalıdır.

## Yayımlanan ikilinin kesin kimliği

- Kaynak etiketi `8.1.2`, commit
  `06ed6fd0a3b2be35b1ab277cc0243f144c04072f`'e karşılık gelir
  ([commit](https://github.com/wader/static-ffmpeg/commit/06ed6fd0a3b2be35b1ab277cc0243f144c04072f),
  [exact Dockerfile](https://github.com/wader/static-ffmpeg/blob/06ed6fd0a3b2be35b1ab277cc0243f144c04072f/Dockerfile)).
- Aynı commitin etiket build'i GitHub Actions run `27713441288`'dir. Her iki
  mimari de bu run içinde native olarak oluşturulmuştur
  ([run](https://github.com/wader/static-ffmpeg/actions/runs/27713441288),
  [exact workflow](https://github.com/wader/static-ffmpeg/blob/06ed6fd0a3b2be35b1ab277cc0243f144c04072f/.github/workflows/multiarch.yml)).
- Dağıtılan OCI manifest-list digest'i
  `sha256:33f770f812cbfc3de96c547157fc9faf8bd95a36481753439ffa761045167585`;
  amd64 manifest'i
  `sha256:3bfa407c614a29a4535f1e3220fd9f6bc9cd7c25483036962e3c8ff711b56e01`;
  arm64 manifest'i
  `sha256:1998feb6c6bd24b57f4240b11300529f6d3bad067fc162d88ab74c4ce479adba`.
  Bunlar platform manifestlerindeki sabit değerlerle aynıdır.
- Dockerfile `ENABLE_FDKAAC` değerini varsayılan olarak boş bırakır. Etiket
  workflow'u build argümanı vermediğinden FDK AAC ikiliye bağlanmamıştır. Bundle
  yeniden üretim komutu da bu değeri boş bırakmalıdır.

## Alpine tabanı ve statik paket kaynakları

Dockerfile `alpine:3.20.3` adını kullansa da build run'ı bunu manifest-list
digest'i
`sha256:1e42bbe2508154c9126d48c2b8a75420c3544343bf86fd041fb7527e017a4b4a`
olarak çözmüştür. Mimari manifestleri amd64 için
`sha256:029a752048e32e843bd6defe3841186fb8d19a28dae8ec287f433bb9d6d1ad85`,
arm64 için
`sha256:ea3c5a9671f7b3f7eb47eab06f73bc6591df978b0d5955689a9e6f943aa368c0`'dir.
Base image annotation'ı Alpine image kaynaklarını commit
`7d63673353bd39d92ba42f6effcc199aeebd45ee`'e bağlar
([docker-alpine snapshot](https://github.com/alpinelinux/docker-alpine/tree/7d63673353bd39d92ba42f6effcc199aeebd45ee)).
Bundle bu kaynak snapshot'ını ve onun iki mimari için sağladığı minirootfs
checksum bilgisini içermelidir.

Build log'u 17 Haziran 2026 19:13 UTC'de Alpine v3.20 `main` ve `community`
indexlerini kullanmıştır. O sırada `3.20-stable` dalındaki en yeni commit expat
2.8.1'e geçmiş olsa da index halen expat 2.7.5-r0 sunuyordu. Bir önceki aports
commit'i `6ba2b85c6ce3a4f89fa6b213120181d4f70ab9f0`, log'daki bütün ilgili paket
sürümleriyle eşleşir
([aports commit](https://gitlab.alpinelinux.org/alpine/aports/-/commit/6ba2b85c6ce3a4f89fa6b213120181d4f70ab9f0)).

Bundle aşağıdaki dizinleri bu committen, dizinin tamamı olarak almalıdır;
yalnız `APKBUILD` dosyasını almak yerel yamaları ve yardımcı dosyaları kaçırır:

```text
main/{musl,gcc,openssl,zlib,bzip2,brotli,libxml2,expat,fontconfig,
      freetype,graphite2,libjpeg-turbo,libpng,fribidi,giflib,fftw,
      libsamplerate,snappy,xz,tiff,libdrm,libpciaccess,numactl,zstd,
      libwebp}
community/{soxr,vo-amrwbenc}
```

Alpine'ın resmi APKBUILD referansına göre `source` hem uzak distfile'ları hem
de build için gereken yerel dosyaları listeler; `sha512sums` bunları doğrular,
`fetch`, `unpack` ve `prepare` adımları ise indirme, açma ve yamaları uygulama
zinciridir
([Alpine APKBUILD Reference](https://wiki.alpinelinux.org/wiki/APKBUILD_Reference)).
Bundler her dizinde `abuild fetch verify` eşdeğerini çalıştırmalı, indirilen
distfile'ı arşive kopyalamalı ve APKBUILD checksum'una ek olarak kendi
SHA-256 manifestini yazmalıdır.

Mühafazakâr kapsam şunları içerir:

- `musl 1.2.5-r3`;
- GCC kökeninden `libgcc`, `libgomp`, `libatomic`, `libstdc++` ve ilgili statik
  nesneler (`gcc 13.2.1_git20240309-r1`);
- `openssl 3.3.7-r0`, `zlib 1.3.2-r0`, `bzip2 1.0.8-r6`,
  `brotli 1.1.0-r2`, `libxml2 2.12.10-r0`, `expat 2.7.5-r0`;
- `fontconfig 2.15.0-r1`, `freetype 2.13.2-r0`, `graphite2 1.3.14-r6`,
  `libjpeg-turbo 3.0.3-r0`, `libpng 1.6.57-r0`, `fribidi 1.0.15-r0`,
  `giflib 5.2.2-r0`, `tiff 4.6.0t-r0`, `libwebp 1.3.2-r0`;
- `fftw 3.3.10-r5`, `libsamplerate 0.2.2-r3`, `snappy 1.1.10-r2`,
  `soxr 0.1.3-r7`, `vo-amrwbenc 0.1.3-r3`, `xz 5.8.3-r0`;
- `libdrm 2.4.120-r0`, `libpciaccess 0.18.1-r0`, `numactl 2.0.18-r0`,
  `zstd 1.5.6-r0`.

Bu liste kasıtlı olarak olası transit girdileri dışlamaz. Kaynak bundle'ını
birkaç megabayt küçültmek için link-time symbol kanıtı olmadan paket elemek
gereksiz uyum riski yaratır.

## Wader'ın doğrudan derlediği kaynaklar

Exact Dockerfile yaklaşık elli proje için sürüm, URL ve SHA-256 tripletleri;
ayrıca bazı projeler için tam git commitleri içerir. Bundle parser'ı bu
Dockerfile'ı tek doğruluk kaynağı olarak okumalı, değişkenleri genişletmeli ve
her arşivi Dockerfile'daki SHA-256 ile doğrulamalıdır
([exact Dockerfile](https://github.com/wader/static-ffmpeg/blob/06ed6fd0a3b2be35b1ab277cc0243f144c04072f/Dockerfile)).

Commit ile alınan kaynaklar arşiv veya `git bundle` olarak fiziksel biçimde
saklanmalıdır:

| Proje          | Commit                                     |
| -------------- | ------------------------------------------ |
| AOM            | `03087864cf4bea6abb0d28f95cf7843511413d8f` |
| libudfread     | `c3cd5cbb097924557ea4d9da1ff76a74620c51a8` |
| game-music-emu | `265d8b90c9b46bd3b892443dee4da585a0384858` |
| libgsm         | `98f1708fb5e06a0dfebd58a3b40d610823db9715` |
| rtmpdump       | `138fdb258d9fc26f1843fd1b891180416c9dc575` |
| uavs3d         | `0e20d2c291853f196c68922a264bcd8471d75b68` |
| x264           | `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` |

`git checkout --recurse-submodules` kullanılan her kaynak için recursive
submodule commitleri de manifestlenmeli ve bundle'a konmalıdır. Dockerfile'ın
uyguladığı bütün `sed`, `rm`, oluşturulan dosya ve symlink işlemleri kaynak
değişikliklerinin build scripti sayılır; bu yüzden Wader repo snapshot'ı
Dockerfile, `checkelf` ve `checkdupsym` ile birlikte eksiksiz saklanmalıdır.

## Üst düzey Dockerfile'da görünmeyen girdiler

### GLib Meson fallback'leri

GLib 2.84.1 kaynak arşivindeki wrap dosyaları aşağıdaki ek girdileri çağırır:

- PCRE2 10.44 source, SHA-256
  `d34f02e113cf7193a1ebf2770d3ac527088d485d4e047ed10e5d217c6ef5de96`;
- Meson WrapDB PCRE2 patch, SHA-256
  `4336d422ee9043847e5e10dbbbd01940d4c9e5027f31ccdc33a7898a1ca94009`;
- proxy-libintl commit
  `33934de09af6a6627eb44e310a8079df009abdbb`;
- sysprof commit `02e50efa49885a5a20a84a8cd7feda10ae7e7e98`.

PCRE2 source ve patch'in URL/checksum'ları GLib'in exact `pcre2.wrap`
dosyasında; diğer commitler aynı source tarball'daki wrap dosyalarındadır
([GLib 2.84.1 source](https://download.gnome.org/sources/glib/2.84/glib-2.84.1.tar.xz)).
Sysprof yapılandırması sonuçta kullanılmamış olsa da exact build-input bundle
için dahil edilmesi tercih edilir.

En önemli belirsizlik GLib'in `libffi.wrap` dosyasıdır: dosya sabit commit
yerine değişebilir `meson` dalını kullanmıştır. Build anında bu dalda bulunan
son commit
`83d0cfd00d7d37af4b4349511d29f1f0512621b3`'tür
([commit](https://gitlab.freedesktop.org/gstreamer/meson-ports/libffi/-/commit/83d0cfd00d7d37af4b4349511d29f1f0512621b3)).
Build log'u libffi fallback'inin statik derlendiğini kanıtlar fakat indirilen
HEAD SHA'sını yazdırmaz. Bu commit zaman çizelgesinden güçlü biçimde çıkarılmış,
upstream provenance ile kriptografik olarak atteste edilmemiştir. Bundle bu
commit'i sabitlemeli ve bu sınırlamayı `PROVENANCE.md` içinde açıkça taşımalıdır.

### Cairo Pixman fallback'i

Cairo 1.18.4, sistemde uygun development paketi bulunmadığı için Pixman
0.43.4 fallback'ini indirmiştir. Exact `pixman.wrap` kaynağı
`https://www.cairographics.org/releases/pixman-0.43.4.tar.gz`, SHA-256 değeri
`a0624db90180c7ddb79fc7a9151093dc37c646d8c38d3f232f767cf64b85a226`'dır
([Cairo 1.18.4 source tree](https://gitlab.freedesktop.org/cairo/cairo/-/tree/1.18.4/subprojects)).

### libjxl alt kaynakları

libjxl 0.11.2'nin `deps.sh` scripti source tarball build'inde dokuz ek snapshot
indirir. Commitler:

| Kaynak        | Commit                                     |
| ------------- | ------------------------------------------ |
| testdata      | `873045a9c42ed60721756e26e2a6b32e17415205` |
| brotli        | `36533a866ed1ca4b75cf049f4521e4ec5fe24727` |
| googletest    | `6910c9d9165801d8827d628cb72eb7ea9dd538c5` |
| highway       | `457c891775a7397bdb0376bb1031e6e027af1c48` |
| skcms         | `b2e692629c1fb19342517d7fb61f1cf83d075492` |
| sjpeg         | `94e0df6d0f8b44228de5be0ff35efb9f946a13c9` |
| zlib          | `51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf` |
| libpng        | `872555f4ba910252783af1507f9e7fe1653be252` |
| libjpeg-turbo | `8ecba3647edb6dd940463fedf38ca33a8e2a73d1` |

Bu değerler upstream'in exact scriptinde tanımlıdır
([libjxl v0.11.2 `deps.sh`](https://github.com/libjxl/libjxl/blob/v0.11.2/deps.sh)).
Script commitleri sabitler fakat indirilen arşivler için checksum doğrulamaz.
Bundler her dokuz commit arşivini şimdi indirmeli, SHA-256 değerini kendi
manifestine yazmalı ve build'i yerel `third_party/` kaynaklarına yöneltmelidir.

### Cargo kaynakları

`librsvg 2.60.0` ve `rav1e 0.7.1` source arşivleri `Cargo.lock` taşır fakat
crate kaynaklarını taşımaz. Build sırasında sırasıyla yüzlerce crates.io
paketi indirilmiştir. Alpine'ın kendi Rust paketleme rehberi de exact lockfile
ve ağ erişimi ilişkisini açıklamaktadır
([Alpine Rust APKBUILD örneği](https://wiki.alpinelinux.org/wiki/APKBUILD_examples%3ARust)).

Bundler her iki source tree üzerinde sürüme uygun Cargo ile `cargo vendor
--locked` çalıştırmalı, vendor dizinini bundle'a koymalı ve üretilen
`.cargo/config.toml` ile çevrimdışı build'i zorlamalıdır. Her registry package
byte'ı `Cargo.lock` içindeki checksum ile, bütün vendor dosyaları da üst bundle
SHA-256 manifestiyle doğrulanmalıdır. Yalnız `Cargo.lock` dosyasını vermek
Corresponding Source'u çevrimdışı sunmaz.

## Önerilen bundle düzeni

```text
n8n-nodes-ytdlp-0.1.0-sources/
  README.md
  PROVENANCE.md
  SHA256SUMS
  manifests/
    bundle.json
    alpine-packages-amd64.txt
    alpine-packages-arm64.txt
    original-build-run.txt
  build/
    static-ffmpeg-06ed6fd.../
    docker-alpine-7d636733.../
    aports-6ba2b85c.../
    offline.Dockerfile
  distfiles/
    direct/
    alpine/
    meson/
    libjxl/
    cargo/librsvg/vendor/
    cargo/rav1e/vendor/
  licenses/
```

`bundle.json` her girdide en az şunları taşımalıdır:

```json
{
  "name": "pcre2",
  "versionOrCommit": "10.44",
  "origin": "https://...",
  "sourceRecipe": "glib-2.84.1/subprojects/pcre2.wrap",
  "sha256": "...",
  "archivePath": "distfiles/meson/pcre2-10.44.tar.bz2",
  "usedBy": ["linux/amd64", "linux/arm64"]
}
```

Kaynak üretim scripti ağ erişimi açıkken yalnız indirme ve doğrulama yapmalı;
doğrulama testi ise arşivi temiz bir dizine açıp ağ erişimi olmadan tüm
manifest girdilerini ve mümkünse build başlangıcını sınamalıdır. Release gate:

1. Her `bundle.json` girdisinin dosyası mevcut ve SHA-256'sı doğru.
2. Dockerfile'daki her URL/commit için tam bir manifest girdisi mevcut.
3. Seçili aports dizinlerindeki her `source` girdisi bundle içinde mevcut ve
   APKBUILD checksum'u geçiyor.
4. libjxl'nin dokuz alt kaynağı ve iki Cargo vendor ağacı tam.
5. `offline.Dockerfile` herhangi bir ağ erişimi denediğinde build başarısız.
6. Bundle aynı GitHub Release'te platform tarball'larıyla yan yana yayımlanıyor
   ve `SOURCE_OFFER.md` bu immutable release asset'ine yöneliyor.

## Bilinen sınırlar ve engeller

- Alpine normal mirror'ları eski APK revizyonlarını kalıcı tutmaz. Örneğin
  build'de kullanılan `expat-2.7.5-r0.apk` güncel mirror'da artık yoktur. Tam
  source sunmak mümkündür; fakat eski APK repository snapshot'ı olmadan
  orijinal Dockerfile ile bit-for-bit ikili yeniden üretimi iddia edilmemelidir.
- `libffi.wrap` build sırasında değişebilir bir dal kullanmıştır. Yukarıdaki
  commit build zamanındaki dal ucu eşlemesidir, retained log'da SHA yoktur.
- GitHub Actions build logları kalıcı kaynak deposu değildir. Run bağlantısı
  provenance kanıtı olarak yararlıdır; bundle oluşturulurken mimari paket
  listeleri ve ilgili log kesiti arşive kopyalanmalıdır.
- Üst düzey arşivlerin tamamının gelecekte upstream'de kalacağı varsayılamaz.
  Bundler bir kaynak bugün indirilemiyorsa release'i durdurmalı; başka sürüme
  sessizce geçmemelidir.
- Bu çalışma Corresponding Source bütünlüğünü hedefler. Bit-for-bit
  reproducible build ayrı bir hedeftir ve exact APK repository'sinin yerel
  yeniden inşası ile iki mimaride karşılaştırmalı binary test gerektirir.
