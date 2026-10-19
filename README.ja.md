# DSH WSL Workspace — 日本語ガイド

[English](README.md) · [简体中文](README.zh.md)

**Windows の DSH から、ローカル WSL の作業ディレクトリを直接扱うためのプラグインです。**
DSH の UI・モデル・セッションは Windows 側に残り、コマンド実行、ファイル編集、
`grep` / `glob` 検索は選択した Linux ディストリビューションで実行します。
WSL 内に DSH をもう一つインストールする必要はありません。

## 必要なもの

Windows の DSH、利用できる WSL ディストリビューション、WSL 内の `python3`（Python 3.8 以降）。

## インストール

Windows DSH のプラグイン管理画面で、**この fork の Git URL** を指定します。

```text
git+https://github.com/yaelysia/dsh-wsl-workspace.git#main
```

有効化した後は **DSH のホストプロセスを完全に終了して再起動**してください。
元プロジェクトの同名 npm パッケージは、この fork の改善を含みません。
更新時は Git の実際のコミットを確認してください。

## 使い方

設定の横にある **W** からディストリビューション、必要に応じて Linux
ユーザー、作業ディレクトリ（例：`/home/me/project`）を選びます。
通常の `read` / `write` / `edit`、`grep` / `glob`、`bash` をそのまま使えます。
Windows ドライブは `/mnt/c/...` からアクセスできます。ファイルと検索は
条件が一致する場合、同じ RPC ワーカーを再利用し、アイドル後に再起動できます。

設定、診断、ファイルサイズや権限の制限は
[English README](README.md) または [中文 README](README.zh.md) を参照してください。
ホットリロードは DSH 本体の機能なので、更新後に完全な再起動が必要な場合があります。

## 元プロジェクトとライセンス

**Fork 元：** https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

**この fork：** https://github.com/yaelysia/dsh-wsl-workspace

独立してメンテナンスされる派生版であり、DSH の公式配布物ではありません。
ライセンスは **MIT**。詳細は [LICENSE](LICENSE) と [NOTICE](NOTICE) を参照してください。
