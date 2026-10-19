# DSH WSL Workspace — Guia rápido em português

[English](README.md) · [简体中文](README.zh.md)

**Use o DSH no Windows para trabalhar diretamente em projetos no WSL local.**
A interface, os modelos e as sessões permanecem no Windows; comandos, acesso
a arquivos e buscas com `grep` / `glob` são executados na distribuição Linux escolhida.
Não é preciso instalar outra cópia do DSH no WSL.

## Requisitos

DSH para Windows, uma distribuição WSL funcional e `python3`
(Python 3.8 ou superior) dentro dessa distribuição.

## Instalação

No gerenciador de plugins do DSH, adicione **a URL Git deste fork**:

```text
git+https://github.com/yaelysia/dsh-wsl-workspace.git#main
```

Ative o plugin e **encerre completamente e reinicie o processo principal do DSH**.
O pacote npm homônimo do projeto original não contém estas melhorias.
Confira o commit Git realmente instalado ao atualizar.

## Como usar

Clique em **W** ao lado das configurações, escolha a distribuição, opcionalmente
o usuário Linux e uma pasta como `/home/me/project`. Use normalmente
`read` / `write` / `edit`, `grep` / `glob` e `bash` dentro do WSL.
Arquivos do Windows continuam acessíveis em `/mnt/c/...`.
Com configurações compatíveis, arquivos e buscas compartilham um worker RPC;
ele pode ser liberado após inatividade e reiniciado quando necessário.

Para opções, diagnósticos e limites de arquivos e permissões, consulte o
[README em inglês](README.md) ou o [README em chinês](README.zh.md).
Uma atualização pode exigir reiniciar totalmente o DSH se o hot reload falhar.

## Origem e licença

**Projeto original (origem do fork):** https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

**Este fork:** https://github.com/yaelysia/dsh-wsl-workspace

Fork mantido de forma independente, não é uma versão oficial do DSH.
Licença **MIT**: [LICENSE](LICENSE) e [NOTICE](NOTICE).
