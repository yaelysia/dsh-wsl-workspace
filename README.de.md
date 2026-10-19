# DSH WSL Workspace — Deutsche Kurzanleitung

[English](README.md) · [简体中文](README.zh.md)

**Mit DSH unter Windows direkt an Projekten in einer lokalen WSL-Distribution arbeiten.**
Oberfläche, Modelle und Sitzungen bleiben unter Windows; Shell, Dateizugriff sowie
`grep` / `glob`-Suche laufen in der ausgewählten Linux-Distribution.
Eine zweite DSH-Installation in WSL ist nicht erforderlich.

## Voraussetzungen

DSH für Windows, eine funktionierende WSL-Distribution und `python3`
(Python 3.8 oder neuer) innerhalb dieser Distribution.

## Installation

Im DSH-Pluginmanager **die Git-Adresse dieses Forks** eintragen:

```text
git+https://github.com/yaelysia/dsh-wsl-workspace.git#main
```

Anschließend das Plugin aktivieren und **DSH einschließlich Hostprozess vollständig
beenden und neu starten**. Das gleichnamige npm-Paket des Ursprungsprojekts
enthält diese Erweiterungen nicht. Bei Updates den installierten Git-Commit prüfen.

## Verwendung

Über **W** neben den Einstellungen die Distribution, optional den Linux-Benutzer
und ein Verzeichnis wie `/home/me/project` auswählen. Die üblichen Werkzeuge
`read` / `write` / `edit`, `grep` / `glob` und `bash` können direkt verwendet werden.
Windows-Dateien sind weiterhin über `/mnt/c/...` erreichbar. Datei- und
Suchzugriffe verwenden bei passenden Einstellungen denselben RPC-Worker;
nach Leerlauf wird er bei Bedarf neu gestartet.

Konfiguration, Diagnose und Grenzen sind im [englischen README](README.md)
und [chinesischen README](README.zh.md) dokumentiert. Das Hot-Reload-Verhalten
wird von DSH selbst gesteuert; gegebenenfalls ist ein vollständiger Neustart nötig.

## Ursprungsprojekt und Lizenz

**Originalprojekt (Fork-Quelle):** https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

**Dieser Fork:** https://github.com/yaelysia/dsh-wsl-workspace

Unabhängig gepflegter Fork, keine offizielle DSH-Version.
**MIT**-Lizenz: [LICENSE](LICENSE) und [NOTICE](NOTICE).
