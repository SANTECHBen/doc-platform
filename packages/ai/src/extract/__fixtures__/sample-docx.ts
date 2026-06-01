// Builds a minimal but valid .docx (in memory) with two embedded PNG figures
// and "Figure N" captions, for testing figure-aware DOCX extraction. Shared by
// docx-figures.test.ts. Kept as code (not a committed binary) so the fixture
// is transparent and regenerates deterministically.

import JSZip from 'jszip';
import sharp from 'sharp';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/>
</Relationships>`;

const drawing = (rid: string, name: string) => `<w:r><w:drawing><wp:inline>
  <wp:extent cx="914400" cy="914400"/>
  <wp:docPr id="1" name="${name}"/>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <pic:pic>
      <pic:nvPicPr><pic:cNvPr id="1" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>
      <pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
      <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
    </pic:pic>
  </a:graphicData></a:graphic>
</wp:inline></w:drawing></w:r>`;

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const heading = (text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${heading('Removal')}
    ${para('Loosen the four mounting bolts in a star pattern.')}
    <w:p>${drawing('rId10', 'image1.png')}</w:p>
    ${para('Figure 1. The four mounting bolts on the bracket.')}
    ${para('Lift the assembly clear of the housing. See Figure 2.')}
    ${heading('Replacement')}
    <w:p>${drawing('rId11', 'image2.png')}</w:p>
    ${para('Figure 2. Seating the replacement assembly.')}
    ${para('Torque the bolts to 25 Nm.')}
  </w:body>
</w:document>`;

function solidPng(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 16, height: 16, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

/** Build a sample procedure .docx with two embedded figures + captions. */
export async function buildSampleProcedureDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels')!.file('.rels', RELS);
  const word = zip.folder('word')!;
  word.file('document.xml', DOCUMENT);
  word.folder('_rels')!.file('document.xml.rels', DOC_RELS);
  const media = word.folder('media')!;
  media.file('image1.png', await solidPng(200, 30, 30));
  media.file('image2.png', await solidPng(30, 30, 200));
  return zip.generateAsync({ type: 'nodebuffer' });
}
