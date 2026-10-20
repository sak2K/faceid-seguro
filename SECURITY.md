# Política de Segurança

## Modelo de ameaça (resumo)

| Ameaça | Mitigação |
|---|---|
| Acesso ao disco/perfil do navegador | Todos os cadastros cifrados com AES-256-GCM; chave derivada da senha (PBKDF2-SHA-256, 600k iterações) |
| Pessoa usando o computador desbloqueado | Bloqueio manual e automático por inatividade; câmera desligada ao bloquear |
| Adivinhação de senha | Custo do PBKDF2 + espera progressiva após 5 tentativas |
| Envio de dados a terceiros / scripts externos | CSP restritiva (`default-src 'self'`), nenhuma dependência de CDN |
| XSS via nomes cadastrados | Renderização somente com `textContent`, sanitização de entradas |
| Clickjacking | `frame-ancestors 'none'` e `X-Frame-Options: DENY` (servidor local) |
| Acesso pela rede local | Servidor escuta somente em `127.0.0.1` |
| Path traversal no servidor | Caminhos normalizados e lista de pastas permitidas |

## Boas práticas para quem usa

- Use uma senha mestra forte e exclusiva.
- Mantenha o navegador e o Windows atualizados.
- Não compartilhe backups; eles só são seguros enquanto a senha for secreta.
- Não use o sistema como único método de autenticação (não há anti-spoofing).

## Reportar vulnerabilidades

Abra uma *issue* privada (Security Advisory) no repositório do GitHub em vez de uma issue pública.
