---
status: accepted
---

# Output layout sabit ve artifact keşfi fail-closed'dur

İlk sürüm her istek workspace'ini `artifacts/`, `temp/` ve `control/` olarak ayıracak; yt-dlp home/temp path'leri ile `%(autonumber)06d-%(id)s.%(ext)s`, `--restrict-filenames` ve `--trim-filenames 160` node-controlled olacak ve kullanıcı output/path/template seçenekleri desteklenmeyecektir. Yalnızca Artifact Directory'nin doğrudan çocukları basename sırasıyla incelenecek; `lstat`, `nlink === 1`, `O_NOFOLLOW`, descriptor `fstat` inode/device eşleşmesi ve parent realpath kontrolünü geçen regular file'lar bütün istek doğrulandıktan sonra Artifact olabilir. Symlink/hardlink/özel dosya/dizin/temp-control kalıntısı veya sıfır final dosya isteği atomik olarak başarısız kılacak; workspace exact doğrulanmış request path üzerinden her sonuç yolunda temizlenecektir.
