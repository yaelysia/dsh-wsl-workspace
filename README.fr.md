# DSH WSL Workspace — Guide rapide en français

[English](README.md) · [简体中文](README.zh.md)

**Utilisez DSH sous Windows pour travailler directement dans un projet WSL local.**
L’interface, les modèles et les sessions DSH restent sous Windows ; le shell,
l’accès aux fichiers et les recherches `grep` / `glob` utilisent la distribution Linux
sélectionnée. Il n’est pas nécessaire d’installer un deuxième DSH dans WSL.

## Prérequis

DSH pour Windows, une distribution WSL fonctionnelle et `python3`
(Python 3.8 ou plus récent) dans cette distribution.

## Installation

Dans le gestionnaire de plugins DSH, ajoutez **l’adresse Git de ce fork** :

```text
git+https://github.com/yaelysia/dsh-wsl-workspace.git#main
```

Activez le plugin, puis **quittez complètement et redémarrez le processus hôte DSH**.
Le paquet npm homonyme du projet d’origine ne contient pas ces améliorations.
Vérifiez le commit Git installé lors d’une mise à jour.

## Utilisation

Cliquez sur **W** près des paramètres, sélectionnez une distribution, éventuellement
un utilisateur Linux, puis un chemin absolu comme `/home/me/project`.
Les outils habituels `read` / `write` / `edit`, `grep` / `glob` et `bash`
fonctionnent sur le projet WSL. Les fichiers Windows restent accessibles
par `/mnt/c/...`. Les opérations sur fichiers et les recherches peuvent
réutiliser le même processus RPC et le recréer après une période d’inactivité.

Pour la configuration, les diagnostics et les limites de sécurité et de taille,
consultez le [guide anglais](README.md) ou le [guide chinois](README.zh.md).
Un redémarrage complet peut être nécessaire si le rechargement à chaud de DSH échoue.

## Projet d’origine et licence

**Projet parent du fork :** https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

**Ce fork :** https://github.com/yaelysia/dsh-wsl-workspace

Ce fork est maintenu indépendamment et n’est pas une version officielle de DSH.
Licence **MIT** : [LICENSE](LICENSE) et [NOTICE](NOTICE).
