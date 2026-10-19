# DSH WSL Workspace — Guía rápida en español

[English](README.md) · [简体中文](README.zh.md)

**Utiliza DSH en Windows para trabajar directamente con proyectos dentro de WSL.**
La interfaz, los modelos y las sesiones de DSH permanecen en Windows; la terminal,
los archivos y la búsqueda `grep` / `glob` se ejecutan en la distribución Linux elegida.
No hace falta instalar otra copia de DSH dentro de WSL.

## Requisitos

DSH para Windows, una distribución WSL operativa y `python3`
(Python 3.8 o posterior) instalado en esa distribución.

## Instalación

En el administrador de plugins de DSH, añade **la URL Git de este fork**:

```text
git+https://github.com/yaelysia/dsh-wsl-workspace.git#main
```

Activa el plugin y **cierra por completo y reinicia el proceso anfitrión de DSH**.
El paquete npm del proyecto original con el mismo nombre no contiene estas mejoras.
Comprueba el commit Git instalado al actualizar.

## Uso

Pulsa **W** junto a la configuración; elige una distribución, opcionalmente un usuario
Linux, y una carpeta como `/home/me/project`. Usa las herramientas normales
`read` / `write` / `edit`, `grep` / `glob` y `bash` sobre ese proyecto.
Los archivos de Windows siguen disponibles en `/mnt/c/...`.
Con la misma configuración, archivos y búsqueda pueden compartir un proceso RPC;
tras un período inactivo, el proceso se vuelve a iniciar cuando sea necesario.

Para la configuración, el diagnóstico y los límites de tamaño y permisos,
consulta la [guía en inglés](README.md) o la [guía en chino](README.zh.md).
Las actualizaciones pueden requerir reiniciar DSH si falla su recarga en caliente.

## Proyecto original y licencia

**Proyecto del que procede el fork:** https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

**Este fork:** https://github.com/yaelysia/dsh-wsl-workspace

Es un fork mantenido de manera independiente, no una versión oficial de DSH.
Licencia **MIT**: [LICENSE](LICENSE) y [NOTICE](NOTICE).
