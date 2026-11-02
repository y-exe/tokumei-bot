import { FileUploadBuilder, LabelBuilder, ModalBuilder } from 'discord.js';
import { automaticUrlLabel, type Config } from '../domain/config.js';
import { input, choice } from './modals.js';

export function editorModal(id: string, action: string, config: Config): ModalBuilder {
  const titles: Record<string, string> = { display: '表示・再送', caption: '画像の説明文', styles: 'ボタンの色', emojis: 'ボタンの絵文字',
    appearance: 'タイトル・説明', images: '画像・サムネイル', labels: 'ボタン名', rules: 'サーバールール',
    limitsbasic: '投稿間隔・通報', spam: '連投対策', identity: '匿名ID・保存期間', filter: '禁止語・ドメイン', import: '設定の読み込み', urlcleanup: 'URLの不要な情報', references: '投稿番号の自動リンク' };
  const modal = new ModalBuilder().setCustomId(`edit:${id}:${action}`).setTitle(titles[action] ?? '設定を編集');
  const toggle=(name:string,label:string,on:boolean)=>choice(name,label,on?'on':'off',[{label:'有効',value:'on'},{label:'無効',value:'off'}]);
  switch (action) {
    case 'restrictionrelease': modal.setTitle('このチャンネルの利用停止を解除').addLabelComponents(input('userId','解除するユーザーのDiscord ID','',20));break;
    case 'urlcleanup': modal.addLabelComponents(choice('cleanUrls','全サイトの既知の計測情報・Xの共有情報',config.policy.cleanUrls !== false ? 'on' : 'off',[{label:'除去する',value:'on',description:'utm_*などを除去。検索条件・画像形式・既知の署名付きURLは維持します。'},{label:'除去しない',value:'off',description:'入力されたURLの共有・計測パラメーターを残します。'}]));break;
    case 'references': modal.addLabelComponents(toggle('linkReferences','本文の >>番号 を投稿リンクに変換',config.policy.linkReferences !== false));break;
    case 'display': modal.addLabelComponents(toggle('repost','匿名・通常投稿ごとに案内を再送',config.panel.repost!==false),choice('urlAutoLabel','URLボタンの名前の決め方',automaticUrlLabel(config)?'on':'off',[{label:'許可したSNS名に合わせる',value:'on',description:'例：Xだけを許可すると「XのURL」になります。'},{label:'設定したボタン名を使う',value:'off',description:'「ボタン設定」で入力した名前（例：URLから画像送信）をそのまま使います。'}]));break;
    case 'caption': modal.addLabelComponents(choice('caption','画像に説明文を付ける',config.content.caption?'on':'off',[{label:'許可する',value:'on'},{label:'許可しない（画像のみ）',value:'off',description:'画像添付・URL変換の説明文欄を非表示にします'}]));break;
    case 'styles': modal.addLabelComponents(...(['text','image','url','help'] as const).map(kind=>choice(`${kind}Style`,`${{text:'投稿',image:'画像',url:'URL',help:'ヘルプ'}[kind]}ボタンの色`,config.panel[`${kind}Style`]??(kind==='text'||kind==='image'&&!config.content.text?'primary':'secondary'),[{label:'青',value:'primary'},{label:'灰',value:'secondary'},{label:'緑',value:'success'},{label:'赤',value:'danger'}])));break;
    case 'emojis': modal.addLabelComponents(...(['text','image','url','help'] as const).map(kind=>input(`${kind}Emoji`,`${{text:'投稿',image:'画像',url:'URL',help:'ヘルプ'}[kind]}ボタンの絵文字（空欄で解除）`,config.panel[`${kind}Emoji`]??'',100,false,false)));break;
    case 'appearance': modal.addLabelComponents(input('title', 'タイトル', config.panel.title, 100), input('description', '説明文', config.panel.description, 1500, true, false), input('color', '色（空欄・なしで解除／例: #5865f2）', config.panel.color === null ? '' : `#${config.panel.color.toString(16).padStart(6, '0')}`, 7, false, false), input('footer', 'フッター（任意）', config.panel.footer, 200, false, false)); break;
    case 'images': modal.addLabelComponents(input('image', '画像URL（空欄で削除）', config.panel.image, 1000, false, false), input('thumbnail', 'サムネイルURL（空欄で削除）', config.panel.thumbnail, 1000, false, false)); break;
    case 'labels': modal.addLabelComponents(input('textLabel', 'テキスト投稿ボタン', config.panel.textLabel, 40), input('imageLabel', '画像投稿ボタン', config.panel.imageLabel, 40), input('urlLabel', 'URL変換ボタン', config.panel.urlLabel, 40), input('helpLabel', 'ヘルプボタン', config.panel.helpLabel, 40)); break;
    case 'rules': modal.addLabelComponents(input('rules', 'サーバールール', config.policy.rules, 2500, true, false), input('rulesUrl', '詳細ルールのURL（任意）', config.policy.rulesUrl, 1000, false, false)); break;
    case 'limitsbasic': modal.addLabelComponents(input('cooldown', '投稿間隔の秒数（0〜3600）', `${config.policy.cooldown}`, 4), input('threshold', '通報通知の人数（1〜50）', `${config.moderation.reportThreshold}`, 2)); break;
    case 'spam': modal.addLabelComponents(
      input('posts', '60秒の投稿上限（0で無効・最大100）', `${config.policy.postsPerMinute}`, 3),
      input('chars60', '60秒の文字数上限（0で無効・最大100000）', `${config.policy.charsPerMinute}`, 6),
      input('chars300', '300秒の文字数上限（0で無効・最大500000）', `${config.policy.charsPerFiveMinutes}`, 6),
      input('timeout', '文字数超過の制限時間（分・1〜1440）', `${config.policy.spamTimeoutMinutes}`, 4),
      input('duplicate', '同一本文の禁止時間（秒・0で無効〜3600）', `${config.policy.duplicateSeconds}`, 4)); break;
    case 'identity': modal.addLabelComponents(toggle('showId','匿名IDを表示',config.identity.showId), input('minutes', '連続投稿のID保持時間（分、0〜1440）', `${config.identity.minutes}`, 4), input('retention', '投稿ログ（0・1〜90日・無期限）', config.policy.retentionDays===null?'無期限':`${config.policy.retentionDays}`, 8), input('reportRetention', '通報内容（0・1〜180日・無期限）', config.policy.reportRetentionDays===null?'無期限':`${config.policy.reportRetentionDays}`, 8)); break;
    case 'filter': modal.addLabelComponents(input('words', '禁止語（1行に1つ、空欄で解除）', config.policy.blockedWords.join('\n'), 3000, true, false), input('domains', '禁止ドメイン（1行に1つ）', config.policy.blockedDomains.join('\n'), 3000, true, false)); break;
    case 'import': modal.addLabelComponents(new LabelBuilder().setLabel('書き出した設定JSON').setFileUploadComponent(new FileUploadBuilder().setCustomId('template').setMinValues(1).setMaxValues(1).setRequired(true))); break;
    default: throw new Error('Unknown editor action');
  }
  return modal;
}
