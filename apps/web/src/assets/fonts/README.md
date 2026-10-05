# Local OCR export font

`NotoSans-Regular.ttf` is the unmodified Noto Sans Regular font from the official
Noto project, pinned to commit `c971829a87e7920f960e7277c3dafd9bedd3c601`:

https://github.com/notofonts/noto-fonts/blob/c971829a87e7920f960e7277c3dafd9bedd3c601/hinted/ttf/NotoSans/NotoSans-Regular.ttf

SHA-256: `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5`

The accompanying `OFL.txt` is the repository's SIL Open Font License 1.1 at the
same commit. The font is bundled by Vite and cached with the application shell;
export never fetches a font from a third party. OCR export embeds only the used
glyphs, preserving their Unicode mapping, and refuses unsupported characters or
shaping instead of substituting or dropping recognized text. This font is not a
claim of support for every language or writing system.
