---
status: accepted
---

# V0.2.0 AI Agent tool olarak sunulmaz

İlk sürüm node description'ında `usableAsTool` tanımlamayacak ve AI Agent tool kullanımını desteklemeyecektir. Exact n8n 2.0.0, 2.27.4 ve 2.30.7 normal-node tool adapter'ı JSON ile binary'yi birlikte döndüren Artifact Item'lardan binary kısmını atıp Agent'a yalnız JSON metadata verir; böylece ağ, process ve binary-storage maliyeti oluşmasına rağmen asıl Artifact çağırana ulaşmaz. Güncel HITL onayı parametre denetimi ekleyebilse de bu veri kaybını düzeltmez ve 2.0.0 floor davranışı doğrulanmamıştır. Ordinary main-connection workflow'ları, açıkça eşlenen upstream AI çıktıları dâhil, kapsamda kalır. AI-tool desteği ancak n8n exact desteklenen binary-tool sözleşmesi sağladığında veya ayrı bounded JSON-only sonuç, storage-reference lifecycle, authorization, approval, network/resource güvenliği ve E2E kararı tasarlandığında yeniden açılabilir.
