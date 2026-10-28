/** Header block of a message that crossed several relays, for the preview suite. */

/** RFC 5322 section 2.1.1 limit on one line. */
export const MAX_HEADER_LINE_OCTETS = 998;

const FOLD_COLUMNS = 72;
const SIGNATURE_ALPHABET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/';

/** Fake, deterministic signature material; folded as DKIM and ARC writers fold the b= tag. */
function signatureBlob(length: number, salt: number): string {
  return Array.from(
    { length },
    (_, i) => SIGNATURE_ALPHABET[(i * 7 + salt * 13) % SIGNATURE_ALPHABET.length],
  ).join('');
}

function fold(text: string): string {
  return (text.match(new RegExp(`.{1,${FOLD_COLUMNS}}`, 'g')) ?? []).join('\r\n\t');
}

function receivedHop(hop: number): string {
  return [
    `Received: from relay-${hop}.example.test (relay-${hop}.example.test [192.0.2.${hop % 250}])`,
    `\tby mx-${hop}.example.test (Postfix) with ESMTPS id 4F${hop}xQ0Zcz3d2K`,
    '\tfor <recipient@example.test>; Tue, 27 Oct 2026 09:12:44 +0000 (UTC)',
  ].join('\r\n');
}

/**
 * The header block (CRLF lines, no closing blank line) that a message forwarded through a
 * relay chain carries: Received hops, DKIM, ARC and long X- headers, all folded.
 * At least `minOctets` long, so it outgrows any slice of the start of the message.
 */
export function relayHeaders(minOctets: number): string {
  const signed = [
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.test; s=sel1;\r\n\tbh=${fold(signatureBlob(44, 1))};\r\n\tb=${fold(signatureBlob(344, 2))}`,
    `ARC-Seal: i=1; a=rsa-sha256; t=1793092364; cv=none; d=example.test; s=arc-20260;\r\n\tb=${fold(signatureBlob(344, 3))}`,
    `ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=example.test; s=arc-20260;\r\n\th=from:to:subject:date:message-id; bh=${fold(signatureBlob(44, 4))};\r\n\tb=${fold(signatureBlob(344, 5))}`,
    `ARC-Authentication-Results: i=1; mx.example.test;\r\n\tdkim=pass header.i=@example.test header.s=sel1 header.b=${signatureBlob(8, 6)};\r\n\tspf=pass smtp.mailfrom=sender@example.test`,
    `X-Gm-Message-State: ${fold(signatureBlob(300, 7))}`,
    `X-Google-Smtp-Source: ${fold(signatureBlob(120, 8))}`,
    `X-Received: by 2002:a05:6000:1234:b0:3a1:5c2d with SMTP id ${signatureBlob(12, 9)};\r\n\tTue, 27 Oct 2026 02:12:43 -0700 (PDT)`,
  ];
  const lines: string[] = [];
  let hop = 0;
  const size = () => lines.join('\r\n').length;
  while (size() < minOctets) {
    hop += 1;
    lines.push(receivedHop(hop));
    if (hop === 1) lines.push(...signed);
  }
  return lines.join('\r\n');
}
