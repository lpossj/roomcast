import { ImagePlus, LoaderCircle, MessageSquare, RotateCcw, Send, X } from 'lucide-react';
import Avatar from '../Avatar.jsx';
import PanelResizeHandle from '../PanelResizeHandle.jsx';
import { timeLabel } from '../lib.js';
import { MAX_CHAT_IMAGES } from '../lib/previewLayout.js';

function ChatItem({ message, selfId, onRecall, onPreview, onImageContextMenu }) {
  if (message.system) return <div className="system-message">{message.text}</div>;
  const own = message.memberId === selfId;
  const images = message.kind === 'image'
    ? (Array.isArray(message.images) && message.images.length
      ? message.images
      : [{ id: message.id, fileName: message.fileName, objectUrl: message.objectUrl }])
    : [];

  return (
    <article className={`chat-message ${own ? 'own-message' : ''}`}>
      <Avatar member={message} />
      <div className="chat-message-body">
        <div className="chat-message-meta">
          <strong>{message.name}</strong>
          <time dateTime={new Date(message.at).toISOString()}>{timeLabel(message.at)}</time>
          {own && !message.recalled && (
            <button type="button" className="chat-recall" title="撤回消息" aria-label="撤回消息" onClick={() => onRecall(message.id)}>
              <RotateCcw size={12} />
            </button>
          )}
        </div>
        {message.recalled ? (
          <p className="recalled-message">该消息已撤回</p>
        ) : message.kind === 'image' ? (
          <>
            {message.text && <p>{message.text}</p>}
            <div className={`chat-image-grid count-${Math.min(images.length, MAX_CHAT_IMAGES)}`}>
              {images.map((image, index) => (
                image.objectUrl ? (
                  <button
                    key={image.id || index}
                    type="button"
                    className="chat-image-button"
                    onClick={() => onPreview({ src: image.objectUrl, alt: image.fileName || `聊天图片 ${index + 1}`, fileName: image.fileName || '' })}
                    onContextMenu={event => onImageContextMenu(event, image.objectUrl)}
                    aria-label={`查看第 ${index + 1} 张大图`}
                  >
                    <img className="chat-image" src={image.objectUrl} alt={image.fileName || `聊天图片 ${index + 1}`} />
                  </button>
                ) : (
                  <p key={image.id || index} className="image-unavailable">图片未保留（{image.fileName || `图片 ${index + 1}`}）</p>
                )
              ))}
            </div>
          </>
        ) : (
          <p>{message.text}</p>
        )}
      </div>
    </article>
  );
}

export default function ChatPanel({
  room,
  selfId,
  desktopChrome,
  resizeHandlers,
  chatDragActive,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  chatListRef,
  chatEndRef,
  onScroll,
  historyLoading,
  hasOlderMessages,
  messages,
  onRecall,
  onPreviewImage,
  onImageContextMenu,
  imageInputRef,
  onChooseImage,
  pendingImages,
  onRemovePendingImage,
  chat,
  setChat,
  onPasteImage,
  sending,
  sendingImage,
  onSendChat,
}) {
  return (
    <aside
      className={`chat-panel ${chatDragActive ? 'chat-drag-active' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <PanelResizeHandle side="chat" handlers={resizeHandlers} />
      <header>
        <h3><MessageSquare size={16} /><span>房间聊天</span></h3>
        {room && <span className="chat-room-badge">{room.members.length} 人</span>}
      </header>

      <div className="chat-messages" ref={chatListRef} onScroll={onScroll} role="log" aria-label="房间聊天记录" aria-live="polite">
        {messages.length === 0 && (
          <div className="workspace-chat-empty">
            <span className="workspace-chat-empty-icon"><MessageSquare size={22} /></span>
            <strong>{room ? '还没有消息' : '尚未加入房间'}</strong>
            <span>{room ? '发送文字、截图或拖入图片开始交流' : '创建或加入房间后即可实时聊天'}</span>
          </div>
        )}
        {room && (historyLoading || hasOlderMessages) && (
          <div className="chat-history-status">
            {historyLoading ? <><LoaderCircle size={13} className="spin" />正在加载消息…</> : '向上滚动加载更早消息'}
          </div>
        )}
        {messages.length > 0 && <div className="chat-date"><span />今天<span /></div>}
        {messages.map(message => (
          <ChatItem
            key={message.seq}
            message={message}
            selfId={selfId}
            onRecall={onRecall}
            onPreview={onPreviewImage}
            onImageContextMenu={onImageContextMenu}
          />
        ))}
        <div ref={chatEndRef} />
      </div>

      <form className="chat-compose" onSubmit={onSendChat}>
        <input
          ref={imageInputRef}
          className="visually-hidden"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
          onChange={onChooseImage}
        />
        <div className="chat-input-wrap">
          {pendingImages.length > 0 && (
            <div className={`chat-pending-images count-${pendingImages.length}`}>
              {pendingImages.map((item, index) => (
                <div className="chat-pending-tile" key={`${item.file.name}-${item.file.lastModified}-${index}`}>
                  <button
                    type="button"
                    className="chat-pending-preview"
                    onClick={() => onPreviewImage({ src: item.objectUrl, alt: item.file.name || `待发送图片 ${index + 1}`, fileName: item.file.name || '' })}
                    aria-label={`查看第 ${index + 1} 张待发送图片`}
                  >
                    <img src={item.objectUrl} alt={item.file.name || `待发送图片 ${index + 1}`} />
                  </button>
                  <button
                    type="button"
                    className="chat-pending-remove"
                    title="移除图片"
                    aria-label={`移除第 ${index + 1} 张待发送图片`}
                    disabled={sendingImage}
                    onClick={() => onRemovePendingImage(index)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            aria-label="发送消息"
            enterKeyHint="send"
            placeholder={room ? `发消息给 ${room.name}` : '加入房间后发送消息'}
            value={chat}
            onChange={event => setChat(event.target.value)}
            onPaste={onPasteImage}
            maxLength={2000}
            disabled={!room || sending || sendingImage}
            rows={2}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault();
                void onSendChat(event);
              }
            }}
          />
          <div className="chat-input-footer">
            <span>{desktopChrome ? 'Enter 发送 · 可粘贴图片' : 'Enter 发送'}</span>
            <span className="chat-actions">
              <button
                type="button"
                title="选择图片"
                aria-label="选择图片"
                disabled={!room || sendingImage || pendingImages.length >= MAX_CHAT_IMAGES}
                onClick={() => imageInputRef.current?.click()}
              >
                {sendingImage ? <LoaderCircle size={16} className="spin" /> : <ImagePlus size={16} />}
              </button>
              <button
                type="submit"
                title="发送消息"
                aria-label="发送消息"
                disabled={!room || (!chat.trim() && !pendingImages.length) || sending || sendingImage}
              >
                {sending ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
              </button>
            </span>
          </div>
        </div>
      </form>
    </aside>
  );
}
