/** BODYSTRUCTURE trees for the ImapService attachment and calendar suites. */

/** An attachment node as imapflow parses it from GreenMail BODYSTRUCTURE. */
export function attachmentNode(part: string, name: string, overrides: object = {}) {
  return {
    part,
    type: 'text/plain',
    parameters: { name },
    encoding: 'base64',
    size: 16,
    lineCount: 1,
    disposition: 'attachment',
    dispositionParameters: { filename: name },
    ...overrides,
  };
}

/** BODYSTRUCTURE GreenMail returns for a text body (part 1) followed by these attachments. */
export function mixedStructure(...attachments: object[]) {
  return {
    childNodes: [
      {
        part: '1',
        type: 'text/plain',
        parameters: { charset: 'utf-8' },
        encoding: '7bit',
        size: 28,
        lineCount: 1,
      },
      ...attachments,
    ],
    type: 'multipart/mixed',
    parameters: { boundary: '--_NmP-97144f485bd10a4e-Part_1' },
  };
}

/** BODYSTRUCTURE GreenMail returns for a text body plus two attachments (parts 2 and 3). */
export function twinAttachmentStructure(filename: string, secondFilename = filename) {
  return mixedStructure(attachmentNode('2', filename), attachmentNode('3', secondFilename));
}

/** The same structure with imapflow's part numbers removed at every depth. */
export function withoutPartNumbers(node: object): object {
  const { childNodes, ...fields } = node as { childNodes?: object[]; part?: string };
  delete fields.part;
  return childNodes ? { ...fields, childNodes: childNodes.map(withoutPartNumbers) } : fields;
}

/** A message whose whole body is one attachment: imapflow gives its root no part number. */
export const singlePartAttachment = {
  type: 'application/pdf',
  parameters: { name: 'a.pdf' },
  encoding: 'base64',
  size: 16,
  disposition: 'attachment',
  dispositionParameters: { filename: 'a.pdf' },
};
