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
      xml(content.replace(/_x[0-9A-Fa-f]{4}_/g, (match) => '_x005F_' + match.slice(1))) + '</t></is></c>';
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
          '" r:id="rId' + (index + 1) + '"' + (sheets[index].hidden ? ' state="hidden"' : '') + '/>').join('') + '</sheets></workbook>'],
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

  // Read ZIP central-directory entries, including DEFLATE files saved by Excel.
  // Limits are checked before and during decompression to bound browser memory.
  async function readWorkbook(buffer) {
    const bytes = new Uint8Array(buffer); const view = new DataView(buffer);
    const limit = 64 * 1024 * 1024;
    if (bytes.length > limit || bytes.length < 22) throw new Error('Choose an XLSX file smaller than 64 MB.');
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054B50) end--;
    if (end < 0 || view.getUint32(end, true) !== 0x06054B50) throw new Error('This file is not a valid XLSX workbook.');
    const entries = view.getUint16(end + 10, true);
    let cursor = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) || entries > 4096) throw new Error('This workbook ZIP format is not supported.');
    const files = new Map(); const decoder = new TextDecoder(); let total = 0;
    for (let index = 0; index < entries; index++) {
      if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014B50) throw new Error('Invalid workbook directory.');
      const flags = view.getUint16(cursor + 8, true);
      const method = view.getUint16(cursor + 10, true);
      const checksum = view.getUint32(cursor + 16, true);
      const size = view.getUint32(cursor + 20, true);
      const expanded = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const local = view.getUint32(cursor + 42, true);
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      cursor += 46 + nameLength + extraLength + commentLength;
      if (cursor > end || flags & 1 || local + 30 > bytes.length) throw new Error('Encrypted or damaged workbook.');
      if (view.getUint32(local, true) !== 0x04034B50) throw new Error('Invalid workbook file entry.');
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (start + size > bytes.length || expanded > limit || (total += expanded) > limit) throw new Error('Workbook contents exceed the 64 MB limit.');
      if (files.has(name)) throw new Error('Duplicate workbook entry.');
      files.set(name, { start, size, expanded, checksum, method });
    }
    const cache = new Map();
    async function documentFor(name, optional = false) {
      if (cache.has(name)) return cache.get(name);
      const entry = files.get(name);
      if (!entry) { if (optional) return null; throw new Error('Missing workbook part: ' + name); }
      let data = bytes.subarray(entry.start, entry.start + entry.size);
      if (entry.method === 8) {
        let decompressor;
        try { decompressor = new DecompressionStream('deflate-raw'); }
        catch (_) { throw new Error('Update your browser to import compressed XLSX files.'); }
        const reader = new Blob([data]).stream().pipeThrough(decompressor).getReader();
        const chunks = []; let length = 0;
        try {
          for (;;) {
            const result = await reader.read(); if (result.done) break;
            length += result.value.length;
            if (length > entry.expanded || length > limit) throw new Error('Workbook decompression limit exceeded.');
            chunks.push(result.value);
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        data = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      } else if (entry.method !== 0) throw new Error('Unsupported workbook compression.');
      if (data.length !== entry.expanded || crc32(data) !== entry.checksum) throw new Error('Workbook checksum mismatch.');
      const source = decoder.decode(data);
      if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('Unsupported XML declarations.');
      const doc = new DOMParser().parseFromString(source, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) throw new Error('Invalid workbook XML.');
      cache.set(name, doc); return doc;
    }
    const all = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];
    const textOf = (node) => all(node, 't').map((item) => item.textContent).join('')
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    const workbook = await documentFor('xl/workbook.xml');
    const relations = await documentFor('xl/_rels/workbook.xml.rels');
    const paths = new Map();
    for (const relation of all(relations, 'Relationship')) {
      if (relation.getAttribute('TargetMode') === 'External') continue;
      const target = relation.getAttribute('Target');
      const path = new URL(target, 'https://workbook.invalid/xl/workbook.xml');
      if (path.origin !== 'https://workbook.invalid') continue;
      paths.set(relation.getAttribute('Id'), decodeURIComponent(path.pathname.slice(1)));
    }
    const sharedPath = all(relations, 'Relationship').find((item) => /\/sharedStrings$/.test(item.getAttribute('Type')))?.getAttribute('Id');
    const sharedDoc = await documentFor(paths.get(sharedPath) || 'xl/sharedStrings.xml', true);
    const strings = sharedDoc ? all(sharedDoc, 'si').map(textOf) : [];
    const sheets = []; let cellCount = 0; let allocatedCells = 0;
    for (const sheet of all(workbook, 'sheet')) {
      const relation = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sheet.getAttribute('r:id');
      const doc = await documentFor(paths.get(relation));
      const rows = [];
      for (const cell of all(doc, 'c')) {
        const address = /^([A-Z]+)([1-9][0-9]*)$/.exec(cell.getAttribute('r') || '');
        if (!address) continue;
        const row = Number(address[2]) - 1;
        const column = [...address[1]].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
        if (row >= 250000 || column >= 512 || ++cellCount > 2000000) throw new Error('Worksheet is too large to import.');
        const type = cell.getAttribute('t');
        const raw = all(cell, 'v')[0]?.textContent ?? '';
        if (all(cell, 'f').length && !all(cell, 'v').length) throw new Error('Recalculate and save formula cells in Excel before importing.');
        if (type === 'e') throw new Error('Resolve spreadsheet cell errors before importing.');
        let value = type === 'inlineStr' ? textOf(cell) : type === 's' ? strings[Number(raw)] : type === 'b' ? (raw === '1' ? 'true' : 'false') : raw;
        if (value == null) throw new Error('Invalid shared string reference.');
        rows[row] ||= [];
        allocatedCells += Math.max(0, column + 1 - rows[row].length);
        if (allocatedCells > 2000000) throw new Error('Worksheet is too large to import.');
        rows[row][column] = String(value);
      }
      const matrix = Array.from({length: rows.length}, (_, r) => Array.from({length: rows[r]?.length || 0}, (_, c) => rows[r][c] ?? ''));
      sheets.push({ name: sheet.getAttribute('name'), hidden: sheet.getAttribute('state') === 'hidden', rows: matrix });
    }
    if (!sheets.length) throw new Error('No worksheets were found.');
    return sheets;
  }

  globalThis.EasyPlateXlsx = { createWorkbook, readWorkbook };
  if (typeof module !== 'undefined' && module.exports) module.exports = { createWorkbook, readWorkbook };
})();
