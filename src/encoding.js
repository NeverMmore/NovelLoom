// 文本编码检测：UTF-8 / UTF-16 / GB18030(GBK/GB2312) / Big5

const COMMON_SIMPLIFIED = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感见明问力理尔点文几定本公特做外孩相西果走将月十实向声车全信重三机工物气每并别真打太新比才便夫再书部水像眼等体却加电主界门利海受听表德少克代员许稜先口由死安写性马光白或住难望教命花结乐色更拉东神记处让母父应直字场平报友关放至张认接告入笑内英军候民岁往何度山觉路带万男边风解叫任金快原吃妈变通师立象数四失满战远格士音轻目条呢';
const COMMON_TRADITIONAL = '的一是了我不人在他有這個上們來到時大地為子中你說生國年著就那和要她出也得裡後自以會家可下而過天去能對小多然於心學麼之都好看起發當沒成只如事把還用第樣道想作種開美總從無情己面最女但現前些所同日手又行意動方期它頭經長兒回位分愛老因很給名法間斯知世什兩次使身者被高已親其進此話常與活正感見明問力理爾點文幾定本公特做外孩相西果走將月十實向聲車全信重三機工物氣每並別真打太新比才便夫再書部水像眼等體卻加電主界門利海受聽表德少克代員許先口由死安寫性馬光白或住難望教命花結樂色更拉東神記處讓母父應直字場平報友關放至張認接告入笑內英軍候民歲往何度山覺路帶萬男邊風解叫任金快原吃媽變通師立象數四失滿戰遠格士音輕目條呢';

function scoreText(text, dict) {
    let good = 0;
    let bad = 0;
    const sample = text.length > 200000 ? text.slice(0, 200000) : text;
    for (const ch of sample) {
        if (ch === '�') bad += 5;
        else if (dict.includes(ch)) good++;
    }
    return good - bad;
}

function tryDecode(buffer, label, fatal = false) {
    try {
        return new TextDecoder(label, { fatal }).decode(buffer);
    } catch {
        return null;
    }
}

/**
 * 检测并解码文本文件
 * @param {ArrayBuffer} buffer
 * @returns {{ text: string, encoding: string }}
 */
export function decodeText(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return { text: tryDecode(buffer.slice(3), 'utf-8') ?? '', encoding: 'UTF-8 (BOM)' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return { text: tryDecode(buffer.slice(2), 'utf-16le') ?? '', encoding: 'UTF-16LE' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return { text: tryDecode(buffer.slice(2), 'utf-16be') ?? '', encoding: 'UTF-16BE' };
    }
    const utf8 = tryDecode(buffer, 'utf-8', true);
    if (utf8 !== null) return { text: utf8, encoding: 'UTF-8' };

    const candidates = [];
    const gb = tryDecode(buffer, 'gb18030');
    if (gb !== null) candidates.push({ text: gb, encoding: 'GB18030/GBK', score: scoreText(gb, COMMON_SIMPLIFIED) });
    const big5 = tryDecode(buffer, 'big5');
    if (big5 !== null) candidates.push({ text: big5, encoding: 'Big5', score: scoreText(big5, COMMON_TRADITIONAL) });
    if (!candidates.length) {
        return { text: tryDecode(buffer, 'utf-8') ?? '', encoding: 'UTF-8 (lossy)' };
    }
    candidates.sort((a, b) => b.score - a.score);
    return { text: candidates[0].text, encoding: candidates[0].encoding };
}

/** 统一换行、去掉 NUL、去掉每行末尾空白 */
export function normalizeNovelText(text) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u0000/g, '')
        .replace(/[ \t　]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n');
}
