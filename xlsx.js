(() => {
  'use strict';

  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

  function xml(value) {
    return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  }

  function columnName(index) {
    let name = '';
    while (index > 0) {
      index--;
      name = String.fromCharCode(65 + index % 26) + name;
      index = Math.floor(index / 26);
    }
    return name;
  }

  function cell(address, value, style = 0) {
    const content = String(value ?? '').slice(0, 32767);
    if (!content) return '<c r="' + address + '" s="' + style + '"/>';
    return '<c r="' + address + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
      xml(content) + '</t></is></c>';
  }

  function sheetName(value, used) {
    const base = (String(value || 'Sheet').replace(/[\\/:*?\[\]]/g, ' ')
      .replace(/[\u0000-\u001F]/g, '').replace(/^'+|'+$/g, '').trim().slice(0, 31)) || 'Sheet';
    let name = base;
    for (let number = 2; used.has(name.toLowerCase()); number++) {
      const suffix = ' (' + number + ')';
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  }

  function color(value) {
    const text = String(value || '').replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6}$/.test(text) ? text : 'FFFFFF';
  }

  function layoutXml(sheet, colorStyles) {
    const lastColumn = columnName(sheet.columns.length + 1);
    const body = [];
    body.push('<row r="1" ht="32" customHeight="1">' + cell('A1', sheet.title, 1) + '</row>');
    body.push('<row r="2" ht="22" customHeight="1">' + cell('A2', sheet.subtitle, 2) + '</row>');
    body.push('<row r="3" ht="22" customHeight="1">' + cell('A3', sheet.note, 2) + '</row>');
    body.push('<row r="4" ht="24" customHeight="1">' +
      cell('A4', '', 3) + sheet.columns.map((label, index) =>
        cell(columnName(index + 2) + '4', label, 3)).join('') + '</row>');
    sheet.rows.forEach((row, rowIndex) => {
      const number = rowIndex + 5;
      const maxLines = Math.max(1, ...row.wells.map((well) => String(well.text ?? '').split('\n').length));
      const height = Math.min(240, Math.max(44, maxLines * 17 + 16));
      const wells = row.wells.map((well, columnIndex) => {
        const style = colorStyles.get(color(well.color)) + (well.locked ? 1 : 0);
        return cell(columnName(columnIndex + 2) + number, well.text, style);
      }).join('');
      body.push('<row r="' + number + '" ht="' + height + '" customHeight="1">' +
        cell('A' + number, row.label, 3) + wells + '</row>');
    });
    const lastRow = sheet.rows.length + 4;
    return XML_HEADER + '<worksheet xmlns="' + SHEET_NS + '">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      '<dimension ref="A1:' + lastColumn + lastRow + '"/>' +
      '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="4" topLeftCell="B5" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="18"/>' +
      '<cols><col min="1" max="1" width="9" customWidth="1"/><col min="2" max="' +
      (sheet.columns.length + 1) + '" width="24" customWidth="1"/></cols>' +
      '<sheetData>' + body.join('') + '</sheetData>' +
      '<mergeCells count="3"><mergeCell ref="A1:' + lastColumn + '1"/><mergeCell ref="A2:' +
      lastColumn + '2"/><mergeCell ref="A3:' + lastColumn + '3"/></mergeCells>' +
      '<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>' +
      '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
  }

  function tableXml(sheet) {
    const lastColumn = columnName(sheet.headers.length);
    const header = sheet.headers.map((value, index) => cell(columnName(index + 1) + '1', value, 3)).join('');
    const rows = ['<row r="1" ht="26" customHeight="1">' + header + '</row>'];
    sheet.rows.forEach((values, index) => {
      const number = index + 2;
      rows.push('<row r="' + number + '">' + values.map((value, columnIndex) =>
        cell(columnName(columnIndex + 1) + number, value)).join('') + '</row>');
    });
    const lastRow = sheet.rows.length + 1;
    return XML_HEADER + '<worksheet xmlns="' + SHEET_NS + '">' +
      '<dimension ref="A1:' + lastColumn + lastRow + '"/>' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="18"/>' +
      '<cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="' +
      sheet.headers.length + '" width="19" customWidth="1"/></cols>' +
      '<sheetData>' + rows.join('') + '</sheetData>' +
      '<autoFilter ref="A1:' + lastColumn + lastRow + '"/></worksheet>';
  }

  function stylesXml(colors) {
    const fills = [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
      ...colors.map((shade) => '<fill><patternFill patternType="solid"><fgColor rgb="FF' +
        shade + '"/><bgColor indexed="64"/></patternFill></fill>')
    ];
    const border = (shade, weight) => '<border>' +
      ['left', 'right', 'top', 'bottom'].map((side) => '<' + side + ' style="' + weight +
        '"><color rgb="FF' + shade + '"/></' + side + '>').join('') + '<diagonal/></border>';
    const wells = colors.map((shade, index) => [1, 2].map((borderId) =>
      '<xf numFmtId="0" fontId="0" fillId="' + (index + 2) +
      '" borderId="' + borderId +
      '" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>').join('')).join('');
    return XML_HEADER + '<styleSheet xmlns="' + SHEET_NS + '">' +
      '<fonts count="4">' +
      '<font><sz val="11"/><color rgb="FF304237"/><name val="Aptos"/></font>' +
      '<font><b/><sz val="18"/><color rgb="FF23352A"/><name val="Aptos"/></font>' +
      '<font><sz val="10"/><color rgb="FF78857C"/><name val="Aptos"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FF526258"/><name val="Aptos"/></font>' +
      '</fonts><fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
      '<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      border('DFE6E1', 'thin') + border('AD713D', 'medium') + '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + (4 + colors.length * 2) + '">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      wells + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function zipFiles(files) {
    const encoder = new TextEncoder();
    const chunks = []; const directory = [];
    let offset = 0; let directorySize = 0;
    for (const [name, content] of files) {
      const filename = encoder.encode(name);
      const data = encoder.encode(content);
      const checksum = crc32(data);
      if (filename.length > 65535 || offset + data.length + filename.length > 0xFFFFFFFF) {
        throw new Error('The workbook is too large for this browser export.');
      }
      const local = new Uint8Array(30);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034B50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint32(14, checksum, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, filename.length, true);
      chunks.push(local, filename, data);

      const central = new Uint8Array(46);
      const entry = new DataView(central.buffer);
      entry.setUint32(0, 0x02014B50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true);
      entry.setUint32(16, checksum, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true);
      entry.setUint16(28, filename.length, true);
      entry.setUint32(42, offset, true);
      directory.push(central, filename);
      directorySize += central.length + filename.length;
      offset += local.length + filename.length + data.length;
    }
    if (files.length > 65535 || offset + directorySize > 0xFFFFFFFF) {
      throw new Error('The workbook is too large for this browser export.');
    }
    const end = new Uint8Array(22);
    const footer = new DataView(end.buffer);
    footer.setUint32(0, 0x06054B50, true);
    footer.setUint16(8, files.length, true);
    footer.setUint16(10, files.length, true);
    footer.setUint32(12, directorySize, true);
    footer.setUint32(16, offset, true);
    return new Blob([...chunks, ...directory, end], { type: XLSX_TYPE });
  }

  function createWorkbook(sheets) {
    if (!Array.isArray(sheets) || !sheets.length) throw new Error('The workbook needs at least one sheet.');
    const usedNames = new Set();
    const names = sheets.map((sheet) => sheetName(sheet.name, usedNames));
    const colors = [...new Set(sheets.filter((sheet) => sheet.type === 'layout')
      .flatMap((sheet) => sheet.rows.flatMap((row) => row.wells.map((well) => color(well.color)))))];
    const colorStyles = new Map(colors.map((shade, index) => [shade, 4 + index * 2]));
    const files = [
      ['[Content_Types].xml', XML_HEADER + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, index) => '<Override PartName="/xl/worksheets/sheet' + (index + 1) +
          '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
        '</Types>'],
      ['_rels/.rels', XML_HEADER + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'],
      ['xl/workbook.xml', XML_HEADER + '<workbook xmlns="' + SHEET_NS +
        '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names.map((name, index) => '<sheet name="' + xml(name) + '" sheetId="' + (index + 1) +
          '" r:id="rId' + (index + 1) + '"/>').join('') + '</sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', XML_HEADER +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, index) => '<Relationship Id="rId' + (index + 1) +
          '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
          (index + 1) + '.xml"/>').join('') +
        '<Relationship Id="rId' + (sheets.length + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>'],
      ['xl/styles.xml', stylesXml(colors)]
    ];
    sheets.forEach((sheet, index) => {
      files.push(['xl/worksheets/sheet' + (index + 1) + '.xml',
        sheet.type === 'layout' ? layoutXml(sheet, colorStyles) : tableXml(sheet)]);
    });
    return zipFiles(files);
  }

  globalThis.EasyPlateXlsx = { createWorkbook };
  if (typeof module !== 'undefined' && module.exports) module.exports = { createWorkbook };
})();
