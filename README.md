# BGL → GLB Converter (GitHub Pages)

MSFS ModelLib BGLに格納されたモデルを抽出し、GeoFSで扱いやすいGLBへ変換する静的Webアプリです。処理はブラウザ内で実行されます。

## GitHub Pagesへの設置

1. GitHubで新しいリポジトリを作成します。
2. ZIPを展開し、`index.html`、`app.mjs`、`converter-core.mjs`、`README.md`、`.nojekyll` と `vendor/` フォルダーを、リポジトリのルートへまとめてアップロードします。
3. リポジトリの **Settings → Pages** を開きます。
4. **Deploy from a branch** を選び、ブランチを `main`、フォルダーを `/ (root)` にして保存します。
5. 発行されたGitHub PagesのURLを開きます。

ZIP読み書きにはJSZip 3.10.1を同梱しています。外部CDNなしで動作します（GitHub Pagesを開くためのインターネット接続は必要です）。JSZipのライセンスは `vendor/JSZip-LICENSE.markdown` を参照してください。

## 使い方

- 空港パッケージのZIPを選び、`BGLを解析` を押します。
- 検出されたモデルから変換対象を選び、`選択モデルをGLBに変換` を押します。
- 1モデルならGLBを直接保存、複数モデルならGLB一式をZIPで保存します。

単独BGLを使う場合は、対応するDDSテクスチャも一緒に選択してください。ZIP全体を選択する方法を推奨します。

## 実装している変換処理

- BGLヘッダーのModelDataセクション（`0x2B`）からRIFF/GLTFモデルを検出
- `GXML` からモデル名とLOD情報を読み取り
- `GLBD` 内の `GLB\0` チャンクからglTF 2.0データを抽出
- 頂点のインターリーブ形式をほどき、属性をfloat32形式の独立したbufferViewへ展開
  - POSITION: float32を保持
  - NORMAL: signed byteをfloat32へ展開し、float32演算でXYZを単位長に正規化してVEC3へ変換
  - TANGENT: signed byteをfloat32へ展開し、float32演算でXYZを単位長に正規化、Wを保持してVEC4へ変換
  - TEXCOORD_0 / TEXCOORD_1: 16bit half-floatをfloat32へ変換
  - COLOR_0: 16bit half-floatをfloat32へ変換
- `ASOBO_primitive.PrimitiveCount` と `StartIndex` からプリミティブ単位のindex範囲・min/maxを再構築
- ノードの非均一スケールを算術平均の均一スケールに変更し、元のスケールをextrasに保存
- ASOBO/MSFS固有拡張をextrasへ移し、MSFT_texture_ddsを標準sourceへ変換
- DXT1 DDSのトップミップをRGBA PNGへ変換し、GLB内へ埋め込み

## 対応範囲と制限

- 対象はMSFS ModelLib BGLに格納されたRIFF/GLTF/GLBDモデルです。配置情報のみを含むScenery BGLは形状データを持たないため、対応するModelLib BGLが必要です。
- DDS画像はDXT1を実装しています。DXT3/DXT5/BC7などの別形式は現時点で未対応です。
- 複数LODは埋め込み順に個別モデルとして出力します。
- すべてのBGL世代・独自拡張への対応を保証するものではありません。未知の頂点形式や画像形式はエラーとして表示します。
- 大型モデルではブラウザのメモリ上限に達する可能性があります。問題が出る場合はモデルを分けて処理してください。

## 今回の入力での検証

付属のKAZE神戸空港パッケージから4モデルを検出し、すべてGLBを生成できることを確認しました。`h051_terminal` は成功例GLBと比較し、全メッシュの変換後BINデータおよび8枚のDDS変換後テクスチャの画素データが一致しています。
