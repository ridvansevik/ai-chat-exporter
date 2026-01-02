/**
 * Gemini Chat Exporter - Gemini content script
 * Exports Gemini chat conversations to Markdown with LaTeX preservation
 */

(function () {
  'use strict';

  // ============================================================================
  // CONSTANTS
  // ============================================================================
  const CONFIG = {
    BUTTON_ID: 'gemini-export-btn',
    DROPDOWN_ID: 'gemini-export-dropdown',
    FILENAME_INPUT_ID: 'gemini-filename-input',
    SELECT_DROPDOWN_ID: 'gemini-select-dropdown',
    FORMAT_DROPDOWN_ID: 'gemini-format-dropdown',
    TOC_CHECKBOX_ID: 'gemini-toc-checkbox',
    CHECKBOX_CLASS: 'gemini-export-checkbox',
    EXPORT_MODE_NAME: 'gemini-export-mode',

    SELECTORS: {
      CHAT_CONTAINER: '[data-test-id="chat-history-container"]',
      CONVERSATION_TURN: 'div.conversation-container',
      USER_QUERY: 'user-query',
      MODEL_RESPONSE: 'model-response',
      COPY_BUTTON: 'button[data-test-id="copy-button"]',
      CONVERSATION_TITLE: '.conversation-title'
    },

    TIMING: {
      SCROLL_DELAY: 1200, // Hızlandırıldı
      CLIPBOARD_CLEAR_DELAY: 200,
      CLIPBOARD_READ_DELAY: 400, // Biraz daha güvenli süre
      MOUSEOVER_DELAY: 500,
      POPUP_DURATION: 900,
      MAX_SCROLL_ATTEMPTS: 60,
      MAX_STABLE_SCROLLS: 4,
      MAX_CLIPBOARD_ATTEMPTS: 15 // Deneme sayısı artırıldı
    },

    STYLES: {
      BUTTON_PRIMARY: '#1a73e8',
      BUTTON_HOVER: '#1765c1',
      DARK_BG: '#111',
      DARK_TEXT: '#fff',
      DARK_BORDER: '#444',
      LIGHT_BG: '#fff',
      LIGHT_TEXT: '#222',
      LIGHT_BORDER: '#ccc'
    }
  };

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================
  const Utils = {
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    isDarkMode() {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    },

    sanitizeFilename(text) {
      const trMap = {
        'ç': 'c', 'Ç': 'C', 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'I': 'I',
        'İ': 'I', 'ö': 'o', 'Ö': 'O', 'ş': 's', 'Ş': 'S', 'ü': 'u', 'Ü': 'U'
      };
      let cleanText = text.replace(/[çÇğĞıIİöÖşŞüÜ]/g, match => trMap[match] || match);
      return cleanText
        .replace(/[\\/:*?"<>|.]/g, '')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '');
    },

    getDateString() {
      const d = new Date();
      const pad = n => n.toString().padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    },

    removeCitations(text) {
      return text
        // Citation işaretlerini kaldır
        .replace(/\[cite_start\]/g, '')
        .replace(/\+\]/g, '')
        // Gemini "Show thinking" yazısını kaldır
        .replace(/^Show thinking\s*/gim, '')
        .replace(/Show thinking\s*/g, '')
        // Fazla boşlukları temizle
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },

    // Regex ile liste düzeltici
    fixBrokenLists(text) {
      return text.replace(/^(\*|\d+\.)\s*\n\s*/gm, '$1 ');
    },

    // Yeni: Elementin metnini Selection API ile alma (daha güvenilir)
    getTextViaSelection(element) {
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
        const text = selection.toString();
        selection.removeAllRanges(); // Temizle
        return text;
      } catch (e) {
        console.error('Selection API hatası:', e);
        return element.innerText || element.textContent;
      }
    },

    // LaTeX içeriklerini koruyarak DOM'dan metin çıkarma (v3 - Geliştirilmiş)
    extractTextWithLatex(element) {
      const result = [];

      // Math container selector'ları
      const MATH_SELECTORS = '.katex, .katex-mathml, .math-inline, .math-block, math, [class*="math"]';

      // Bir node'un math container içinde olup olmadığını kontrol et
      const isInsideMathContainer = (node) => {
        let parent = node.parentElement;
        while (parent && parent !== element) {
          const classNameStr = typeof parent.className === 'string'
            ? parent.className
            : (parent.className?.baseVal || parent.getAttribute?.('class') || '');

          if (parent.tagName?.toLowerCase() === 'math' ||
            classNameStr.includes('katex') ||
            classNameStr.includes('math-inline') ||
            classNameStr.includes('math-block')) {
            return true;
          }
          parent = parent.parentElement;
        }
        return false;
      };

      // LaTeX kaynağını bul ve çıkar (Gemini data-math attribute kullanıyor)
      const extractLatexFromElement = (el) => {
        // 1. Gemini's data-math attribute (öncelikli)
        const dataMath = el.getAttribute('data-math');
        if (dataMath) {
          return dataMath.trim();
        }

        // 2. Annotation elementi (diğer sistemler için)
        const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
        if (annotation) {
          return annotation.textContent?.trim() || null;
        }

        return null;
      };

      // Element'in block math olup olmadığını kontrol et
      const isBlockMath = (el) => {
        const classNameStr = typeof el.className === 'string'
          ? el.className
          : (el.className?.baseVal || el.getAttribute?.('class') || '');

        return classNameStr.includes('math-block') ||
          classNameStr.includes('katex-display') ||
          el.closest('.math-block') !== null ||
          el.closest('.katex-display') !== null ||
          el.getAttribute?.('display') === 'block';
      };

      const processNode = (node) => {
        // TEXT NODE
        if (node.nodeType === Node.TEXT_NODE) {
          // Math container içindeki text node'ları atla (bunlar görsel render)
          if (isInsideMathContainer(node)) {
            return;
          }

          const text = node.textContent;
          if (text && text.trim()) {
            result.push(text);
          }
          return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const el = node;
        const tagName = el.tagName?.toLowerCase() || '';

        // className'i güvenli şekilde string'e çevir
        const classNameStr = typeof el.className === 'string'
          ? el.className
          : (el.className?.baseVal || el.getAttribute?.('class') || '');

        // Class kontrolü için yardımcı fonksiyon
        const hasClass = (className) => {
          return el.classList?.contains(className) || classNameStr.includes(className);
        };

        // Skip checkbox elements
        if (hasClass(CONFIG.CHECKBOX_CLASS)) return;

        // ============ MATH ELEMENT TESPİTİ ============
        // Math container bulunduğunda, LaTeX'i çıkar ve children'ı işleme

        // 1. Doğrudan annotation içeren element
        const latex = extractLatexFromElement(el);
        if (latex) {
          const isBlock = isBlockMath(el);
          result.push(isBlock ? ` $$${latex}$$ ` : ` $${latex}$ `);
          return; // Children'ı işleme - LaTeX zaten çıkarıldı
        }

        // 2. math-inline veya math-block class'ı (annotation olmadan)
        if (hasClass('math-inline') || hasClass('math-block')) {
          // Alt elementlerde annotation ara
          const innerLatex = extractLatexFromElement(el);
          if (innerLatex) {
            const isBlock = hasClass('math-block');
            result.push(isBlock ? ` $$${innerLatex}$$ ` : ` $${innerLatex}$ `);
            return;
          }
          // Annotation yoksa, bu elementi atla (görsel render)
          return;
        }

        // 3. KaTeX elementleri
        if (hasClass('katex') || hasClass('katex-mathml')) {
          const innerLatex = extractLatexFromElement(el);
          if (innerLatex) {
            const isDisplay = hasClass('katex-display') || el.closest('.katex-display');
            result.push(isDisplay ? ` $$${innerLatex}$$ ` : ` $${innerLatex}$ `);
            return;
          }
          // KaTeX elementi ama LaTeX bulunamadı - atla
          return;
        }

        // 4. MathML <math> elementi
        if (tagName === 'math') {
          const innerLatex = extractLatexFromElement(el);
          if (innerLatex) {
            const display = el.getAttribute('display');
            result.push(display === 'block' ? ` $$${innerLatex}$$ ` : ` $${innerLatex}$ `);
            return;
          }
          return;
        }

        // 5. semantics elementi (MathML)
        if (tagName === 'semantics') {
          const innerLatex = extractLatexFromElement(el);
          if (innerLatex) {
            const parentMath = el.closest('math');
            const display = parentMath?.getAttribute('display');
            result.push(display === 'block' ? ` $$${innerLatex}$$ ` : ` $${innerLatex}$ `);
            return;
          }
        }

        // ============ DİĞER ELEMENTLER ============

        // Skip hidden or aria-hidden elements
        if (el.getAttribute('aria-hidden') === 'true') {
          return;
        }

        // ============ TABLO DESTEĞİ ============
        if (tagName === 'table') {
          const rows = el.querySelectorAll('tr');
          if (rows.length > 0) {
            result.push('\n');
            rows.forEach((row, rowIndex) => {
              const cells = row.querySelectorAll('th, td');
              const cellTexts = Array.from(cells).map(cell => cell.textContent?.trim() || '');
              result.push('| ' + cellTexts.join(' | ') + ' |\n');

              // Header separator after first row
              if (rowIndex === 0) {
                result.push('|' + cellTexts.map(() => '---').join('|') + '|\n');
              }
            });
            result.push('\n');
            return;
          }
        }

        // ============ LİNK KORUMA ============
        if (tagName === 'a') {
          const href = el.getAttribute('href');
          const linkText = el.textContent?.trim() || href;
          if (href && !href.startsWith('#')) {
            // Dış link
            result.push(`[${linkText}](${href})`);
          } else {
            // İç link veya anchor - sadece metni al
            result.push(linkText);
          }
          return;
        }

        // ============ GÖRSEL PLACEHOLDER ============
        if (tagName === 'img') {
          const alt = el.getAttribute('alt') || 'image';
          const src = el.getAttribute('src');
          if (src && !src.startsWith('data:image/svg')) {
            // Base64 olmayan görseller için placeholder
            result.push(`\n![${alt}](${src})\n`);
          } else if (alt && alt !== 'image') {
            result.push(`[📷 Image: ${alt}]`);
          }
          return;
        }

        // ============ BLOCKQUOTE ============
        if (tagName === 'blockquote') {
          result.push('\n');
          const quoteText = el.textContent?.trim() || '';
          quoteText.split('\n').forEach(line => {
            result.push(`> ${line.trim()}\n`);
          });
          result.push('\n');
          return;
        }

        // ============ STRIKETHROUGH ============
        if (tagName === 'del' || tagName === 's' || tagName === 'strike') {
          result.push('~~');
          for (const child of el.childNodes) {
            processNode(child);
          }
          result.push('~~');
          return;
        }

        // ============ UNDERLINE (Markdown'da yok, bold olarak göster) ============
        if (tagName === 'u') {
          result.push('__');
          for (const child of el.childNodes) {
            processNode(child);
          }
          result.push('__');
          return;
        }

        // ============ CODE BLOCKS (Geliştirilmiş) ============
        if (tagName === 'pre') {
          const codeEl = el.querySelector('code') || el;
          const codeContent = codeEl.textContent;
          if (codeContent) {
            // Dil tespiti - birden fazla kaynak dene
            let lang = '';

            // 1. Class'tan language-xxx
            const langClass = classNameStr.match(/language-(\w+)/) ||
              codeEl.className?.match?.(/language-(\w+)/);
            if (langClass) lang = langClass[1];

            // 2. data-language attribute
            if (!lang) lang = el.getAttribute('data-language') || codeEl.getAttribute('data-language') || '';

            // 3. Otomatik tespit (basit heuristik)
            if (!lang && codeContent.length > 20) {
              if (codeContent.includes('def ') && codeContent.includes(':')) lang = 'python';
              else if (codeContent.includes('function') || codeContent.includes('=>')) lang = 'javascript';
              else if (codeContent.includes('public class') || codeContent.includes('System.out')) lang = 'java';
              else if (codeContent.includes('#include') || codeContent.includes('int main')) lang = 'cpp';
              else if (codeContent.includes('<?php')) lang = 'php';
              else if (codeContent.includes('SELECT') && codeContent.includes('FROM')) lang = 'sql';
              else if (codeContent.includes('<html') || codeContent.includes('</div>')) lang = 'html';
              else if (codeContent.match(/^\s*\{[\s\S]*\}\s*$/)) lang = 'json';
              else if (codeContent.includes('#!/bin/bash') || codeContent.includes('$ ')) lang = 'bash';
            }

            result.push(`\n\`\`\`${lang}\n${codeContent.trim()}\n\`\`\`\n`);
            return;
          }
        }

        // Inline code
        if (tagName === 'code' && !el.closest('pre')) {
          result.push(`\`${el.textContent}\``);
          return;
        }

        // ============ DEFİNİSYON LİSTESİ ============
        if (tagName === 'dl') {
          result.push('\n');
          for (const child of el.childNodes) {
            processNode(child);
          }
          result.push('\n');
          return;
        }

        if (tagName === 'dt') {
          result.push('\n**');
          for (const child of el.childNodes) {
            processNode(child);
          }
          result.push('**\n');
          return;
        }

        if (tagName === 'dd') {
          result.push(': ');
          for (const child of el.childNodes) {
            processNode(child);
          }
          result.push('\n');
          return;
        }

        // Block elements
        const blockElements = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
        const isBlockEl = blockElements.includes(tagName);

        // Line breaks - özel işleme
        if (tagName === 'br') {
          result.push('\n');
          return;
        }

        // Horizontal rule
        if (tagName === 'hr') {
          result.push('\n---\n');
          return;
        }

        // Headings
        if (tagName.match(/^h[1-6]$/)) {
          const level = parseInt(tagName[1]);
          result.push(`\n${'#'.repeat(level)} `);
          // Children'ı işle (heading içinde math olabilir)
          for (const child of el.childNodes) {
            processNode(child);
          }
          result.push('\n');
          return;
        }

        // Lists - numaralandırma için sayaç tut
        if (tagName === 'ul' || tagName === 'ol') {
          result.push('\n');

          // Sıralı listeler için çocukları numaralı işle
          let itemIndex = 0;
          for (const child of el.childNodes) {
            if (child.nodeType === Node.ELEMENT_NODE && child.tagName?.toLowerCase() === 'li') {
              itemIndex++;
              child._listIndex = itemIndex; // Geçici index sakla
            }
            processNode(child);
          }
          result.push('\n');
          return;
        }

        // List items - doğru numaralandırma ve indent
        if (tagName === 'li') {
          const listParent = el.parentElement;

          // İç içe derinlik hesapla
          let depth = 0;
          let parent = listParent?.parentElement;
          while (parent) {
            if (parent.tagName?.toLowerCase() === 'li') {
              depth++;
            }
            parent = parent.parentElement;
          }
          const indent = '  '.repeat(depth);

          const isOrdered = listParent?.tagName?.toLowerCase() === 'ol';

          // Doğru numara veya bullet
          let prefix;
          if (isOrdered) {
            const index = el._listIndex ||
              (Array.from(listParent.children).filter(c => c.tagName?.toLowerCase() === 'li').indexOf(el) + 1);
            prefix = `${index}. `;
          } else {
            prefix = '* ';
          }

          result.push(`\n${indent}${prefix}`);
          for (const child of el.childNodes) {
            processNode(child);
          }
          return;
        }

        // Bold - children'ı işle (içinde math olabilir)
        if (tagName === 'strong' || tagName === 'b') {
          result.push('**');
          for (const child of el.childNodes) {
            processNode(child);
          }
          result.push('**');
          return;
        }

        // Italic
        if (tagName === 'em' || tagName === 'i') {
          result.push('*');
          for (const child of el.childNodes) {
            processNode(child);
          }
          result.push('*');
          return;
        }

        // Paragraph
        if (tagName === 'p') {
          result.push('\n');
          for (const child of el.childNodes) {
            processNode(child);
          }
          result.push('\n');
          return;
        }

        // Generic block element
        if (isBlockEl) {
          result.push('\n');
        }

        // Process children for other elements
        for (const child of el.childNodes) {
          processNode(child);
        }

        if (isBlockEl) {
          result.push('\n');
        }
      };

      processNode(element);

      // Clean up the result
      let text = result.join('');

      // Çift dolar işaretleri etrafında boşluk düzeltme
      text = text.replace(/\s+\$\$/g, ' $$');
      text = text.replace(/\$\$\s+/g, '$$ ');
      text = text.replace(/\s+\$/g, ' $');
      text = text.replace(/\$\s+/g, '$ ');

      // Normalize whitespace but preserve intentional line breaks
      text = text.replace(/[ \t]+/g, ' ');
      text = text.replace(/\n{3,}/g, '\n\n');
      text = text.replace(/\n +/g, '\n');
      text = text.trim();

      return text;
    },

    // Gelişmiş Toast Notification Sistemi
    createToast(message, type = 'info', duration = 2000) {
      // Mevcut toast'ları temizle
      const existingToast = document.getElementById('gemini-toast');
      if (existingToast) existingToast.remove();

      const colors = {
        success: { bg: 'linear-gradient(135deg, #10b981, #059669)', icon: '✓' },
        error: { bg: 'linear-gradient(135deg, #ef4444, #dc2626)', icon: '✕' },
        info: { bg: 'linear-gradient(135deg, #3b82f6, #2563eb)', icon: 'ℹ' },
        warning: { bg: 'linear-gradient(135deg, #f59e0b, #d97706)', icon: '⚠' }
      };

      const toast = document.createElement('div');
      toast.id = 'gemini-toast';
      toast.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:1.2em;">${colors[type]?.icon || 'ℹ'}</span>
          <span>${message}</span>
        </div>
      `;

      Object.assign(toast.style, {
        position: 'fixed',
        top: '20px',
        right: '20px',
        zIndex: '999999',
        background: colors[type]?.bg || colors.info.bg,
        color: '#fff',
        padding: '14px 20px',
        borderRadius: '12px',
        fontSize: '14px',
        fontWeight: '500',
        boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        transform: 'translateX(120%)',
        transition: 'transform 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      });

      document.body.appendChild(toast);

      // Animate in
      requestAnimationFrame(() => {
        toast.style.transform = 'translateX(0)';
      });

      // Animate out
      setTimeout(() => {
        toast.style.transform = 'translateX(120%)';
        setTimeout(() => toast.remove(), 400);
      }, duration);

      return toast;
    },

    // Progress Toast (güncellenebilir)
    createProgressToast(initialMessage) {
      const toast = document.createElement('div');
      toast.id = 'gemini-progress-toast';
      toast.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px;min-width:250px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div class="spinner" style="width:18px;height:18px;border:2px solid rgba(255,255,255,0.3);border-top:2px solid #fff;border-radius:50%;animation:spin 1s linear infinite;"></div>
            <span id="progress-message">${initialMessage}</span>
          </div>
          <div style="background:rgba(255,255,255,0.2);border-radius:4px;height:4px;overflow:hidden;">
            <div id="progress-bar" style="height:100%;width:0%;background:#fff;transition:width 0.3s ease;"></div>
          </div>
        </div>
      `;

      // Add spinner animation
      const style = document.createElement('style');
      style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
      toast.appendChild(style);

      Object.assign(toast.style, {
        position: 'fixed',
        top: '20px',
        right: '20px',
        zIndex: '999999',
        background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
        color: '#fff',
        padding: '16px 20px',
        borderRadius: '12px',
        fontSize: '14px',
        fontWeight: '500',
        boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
        transform: 'translateX(120%)',
        transition: 'transform 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      });

      document.body.appendChild(toast);
      requestAnimationFrame(() => {
        toast.style.transform = 'translateX(0)';
      });

      return {
        update: (message, progress) => {
          const msgEl = toast.querySelector('#progress-message');
          const barEl = toast.querySelector('#progress-bar');
          if (msgEl) msgEl.textContent = message;
          if (barEl) barEl.style.width = `${progress}%`;
        },
        close: () => {
          toast.style.transform = 'translateX(120%)';
          setTimeout(() => toast.remove(), 400);
        }
      };
    },

    // Legacy uyumluluk için
    createNotification(message) {
      return this.createToast(message, 'info', CONFIG.TIMING.POPUP_DURATION);
    },

    // İstatistik hesaplama
    calculateStats(markdown) {
      const words = markdown.split(/\s+/).filter(w => w.length > 0).length;
      const chars = markdown.length;
      const lines = markdown.split('\n').length;
      const codeBlocks = (markdown.match(/```/g) || []).length / 2;
      const mathExpressions = (markdown.match(/\$[^$]+\$/g) || []).length;

      return { words, chars, lines, codeBlocks: Math.floor(codeBlocks), mathExpressions };
    }
  };

  // ============================================================================
  // CHECKBOX MANAGER
  // ============================================================================
  class CheckboxManager {
    createCheckbox(type, container) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = CONFIG.CHECKBOX_CLASS;
      cb.checked = true;
      cb.title = `Include this ${type} message in export`;

      Object.assign(cb.style, {
        position: 'absolute',
        right: '28px',
        top: '8px',
        zIndex: '10000',
        transform: 'scale(1.2)'
      });

      container.style.position = 'relative';
      container.appendChild(cb);
      return cb;
    }

    injectCheckboxes() {
      const turns = document.querySelectorAll(CONFIG.SELECTORS.CONVERSATION_TURN);

      turns.forEach(turn => {
        // User query checkbox
        const userQueryElem = turn.querySelector(CONFIG.SELECTORS.USER_QUERY);
        if (userQueryElem && !userQueryElem.querySelector(`.${CONFIG.CHECKBOX_CLASS}`)) {
          this.createCheckbox('user', userQueryElem);
        }

        // Model response checkbox
        const modelRespElem = turn.querySelector(CONFIG.SELECTORS.MODEL_RESPONSE);
        if (modelRespElem && !modelRespElem.querySelector(`.${CONFIG.CHECKBOX_CLASS}`)) {
          this.createCheckbox('Gemini', modelRespElem);
        }
      });
    }

    removeAll() {
      document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`).forEach(cb => cb.remove());
    }

    hasAnyChecked() {
      return Array.from(document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`))
        .some(cb => cb.checked);
    }
  }

  // ============================================================================
  // SELECTION MANAGER
  // ============================================================================
  class SelectionManager {
    constructor(checkboxManager) {
      this.checkboxManager = checkboxManager;
      this.lastSelection = 'all';
    }

    applySelection(value) {
      const checkboxes = document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`);

      switch (value) {
        case 'all':
          checkboxes.forEach(cb => cb.checked = true);
          break;
        case 'ai':
          document.querySelectorAll(`${CONFIG.SELECTORS.USER_QUERY} .${CONFIG.CHECKBOX_CLASS}`)
            .forEach(cb => cb.checked = false);
          document.querySelectorAll(`${CONFIG.SELECTORS.MODEL_RESPONSE} .${CONFIG.CHECKBOX_CLASS}`)
            .forEach(cb => cb.checked = true);
          break;
        case 'none':
          checkboxes.forEach(cb => cb.checked = false);
          break;
      }

      this.lastSelection = value;
    }

    reset() {
      this.lastSelection = 'all';
      const select = document.getElementById(CONFIG.SELECT_DROPDOWN_ID);
      if (select) select.value = 'all';
    }

    reapplyIfNeeded() {
      const select = document.getElementById(CONFIG.SELECT_DROPDOWN_ID);
      if (select && this.lastSelection !== 'custom') {
        select.value = this.lastSelection;
        this.applySelection(this.lastSelection);
      }
    }
  }

  // ============================================================================
  // UI BUILDER
  // ============================================================================
  class UIBuilder {
    static getInputStyles(isDark) {
      return isDark
        ? `background:${CONFIG.STYLES.DARK_BG};color:${CONFIG.STYLES.DARK_TEXT};border:1px solid ${CONFIG.STYLES.DARK_BORDER};`
        : `background:${CONFIG.STYLES.LIGHT_BG};color:${CONFIG.STYLES.LIGHT_TEXT};border:1px solid ${CONFIG.STYLES.LIGHT_BORDER};`;
    }

    static createDropdownHTML() {
      const isDark = Utils.isDarkMode();
      const inputStyles = this.getInputStyles(isDark);

      return `
        <div style="margin-top:10px;">
          <label style="margin-right:10px;">
            <input type="radio" name="${CONFIG.EXPORT_MODE_NAME}" value="file" checked>
            Export as file
          </label>
          <label>
            <input type="radio" name="${CONFIG.EXPORT_MODE_NAME}" value="clipboard">
            Export to clipboard
          </label>
        </div>
        
        <div style="margin-top:12px;">
          <label style="font-weight:bold;">Format:</label>
          <select id="${CONFIG.FORMAT_DROPDOWN_ID}" 
                  style="margin-left:8px;padding:4px 12px;${inputStyles};border-radius:4px;">
            <option value="md" selected>📝 Markdown (.md)</option>
            <option value="json">📊 JSON (.json)</option>
            <option value="html">🌐 HTML (.html)</option>
            <option value="txt">📄 Plain Text (.txt)</option>
          </select>
        </div>

        <div style="margin-top:12px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="${CONFIG.TOC_CHECKBOX_ID}" checked 
                   style="width:16px;height:16px;">
            <span>📑 Include Table of Contents</span>
          </label>
        </div>

        <div id="gemini-filename-row" style="margin-top:12px;display:block;">
          <label for="${CONFIG.FILENAME_INPUT_ID}" style="font-weight:bold;">
            Filename <span style='color:#888;font-weight:normal;'>(optional)</span>:
          </label>
          <input id="${CONFIG.FILENAME_INPUT_ID}" type="text" 
                 style="margin-left:8px;padding:4px 8px;width:240px;${inputStyles};border-radius:4px;" 
                 value="" placeholder="auto-generated">
        </div>

        <div style="margin-top:14px;">
          <label style="font-weight:bold;">Select messages:</label>
          <select id="${CONFIG.SELECT_DROPDOWN_ID}" 
                  style="margin-left:8px;padding:4px 12px;${inputStyles};border-radius:4px;">
            <option value="all">All</option>
            <option value="ai">Only answers</option>
            <option value="none">None</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        <div style="margin-top:14px;padding-top:10px;border-top:1px solid ${isDark ? '#444' : '#ddd'};font-size:0.85em;color:#888;">
          💡 Tip: Use <kbd style="background:${isDark ? '#333' : '#eee'};padding:2px 6px;border-radius:3px;">Ctrl+Shift+E</kbd> for quick export
        </div>
      `;
    }

    static createButton() {
      const btn = document.createElement('button');
      btn.id = CONFIG.BUTTON_ID;
      btn.textContent = 'Export Chat';

      Object.assign(btn.style, {
        position: 'fixed',
        top: '80px',
        right: '20px',
        zIndex: '9999',
        padding: '8px 16px',
        background: CONFIG.STYLES.BUTTON_PRIMARY,
        color: '#fff',
        border: 'none',
        borderRadius: '6px',
        fontSize: '1em',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        cursor: 'pointer',
        fontWeight: 'bold',
        transition: 'background 0.2s'
      });

      btn.addEventListener('mouseenter', () => btn.style.background = CONFIG.STYLES.BUTTON_HOVER);
      btn.addEventListener('mouseleave', () => btn.style.background = CONFIG.STYLES.BUTTON_PRIMARY);

      return btn;
    }

    static createDropdown() {
      const dropdown = document.createElement('div');
      dropdown.id = CONFIG.DROPDOWN_ID;

      const isDark = Utils.isDarkMode();
      Object.assign(dropdown.style, {
        position: 'fixed',
        top: '124px',
        right: '20px',
        zIndex: '9999',
        border: '1px solid #ccc',
        borderRadius: '6px',
        padding: '10px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        display: 'none',
        background: isDark ? '#222' : '#fff',
        color: isDark ? '#fff' : '#222'
      });

      dropdown.innerHTML = this.createDropdownHTML();
      return dropdown;
    }
  }

  // ============================================================================
  // EXPORT SERVICE
  // ============================================================================
  class ExportService {
    constructor(checkboxManager) {
      this.checkboxManager = checkboxManager;
    }

    async scrollToLoadAll() {
      const scrollContainer = document.querySelector(CONFIG.SELECTORS.CHAT_CONTAINER);
      if (!scrollContainer) throw new Error('Sohbet geçmişi bulunamadı.');

      let stableScrolls = 0;
      let scrollAttempts = 0;
      let lastScrollTop = null;

      while (stableScrolls < CONFIG.TIMING.MAX_STABLE_SCROLLS &&
        scrollAttempts < CONFIG.TIMING.MAX_SCROLL_ATTEMPTS) {
        const currentTurnCount = document.querySelectorAll(CONFIG.SELECTORS.CONVERSATION_TURN).length;
        scrollContainer.scrollTop = 0;
        await Utils.sleep(CONFIG.TIMING.SCROLL_DELAY);

        const scrollTop = scrollContainer.scrollTop;
        const newTurnCount = document.querySelectorAll(CONFIG.SELECTORS.CONVERSATION_TURN).length;

        if (newTurnCount === currentTurnCount && (lastScrollTop === scrollTop || scrollTop === 0)) {
          stableScrolls++;
        } else {
          stableScrolls = 0;
        }
        lastScrollTop = scrollTop;
        scrollAttempts++;
      }
    }

    async copyModelResponse(turn, copyBtn, index) {
      try { await navigator.clipboard.writeText(''); } catch (e) { }

      let attempts = 0;
      let clipboardText = '';

      while (attempts < CONFIG.TIMING.MAX_CLIPBOARD_ATTEMPTS) {
        const modelRespElem = turn.querySelector(CONFIG.SELECTORS.MODEL_RESPONSE);
        if (modelRespElem) {
          modelRespElem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        }

        await Utils.sleep(CONFIG.TIMING.CLIPBOARD_CLEAR_DELAY);

        try {
          copyBtn.click();
          await Utils.sleep(CONFIG.TIMING.CLIPBOARD_READ_DELAY);
          clipboardText = await navigator.clipboard.readText();

          // Boş değilse yeterli (kısa matematik formülleri için limit kaldırıldı)
          if (clipboardText && clipboardText.trim().length > 0) {
            break;
          }
        } catch (err) {
          console.error(`Deneme ${attempts + 1} Hata:`, err);
        }
        attempts++;
      }
      return clipboardText;
    }

    getConversationTitle() {
      const titleCard = document.querySelector(CONFIG.SELECTORS.CONVERSATION_TITLE);
      return titleCard ? titleCard.textContent.trim() : '';
    }

    generateFilename(customFilename, conversationTitle) {
      if (customFilename && customFilename.trim()) {
        let base = customFilename.trim().replace(/\.[^/.]+$/, '');
        base = base.replace(/[^a-zA-Z0-9_\-]/g, '_');
        return base || `gemini_chat_export_${Utils.getDateString()}`;
      }
      if (conversationTitle) {
        const safeTitle = Utils.sanitizeFilename(conversationTitle);
        if (safeTitle) return `${safeTitle}_${Utils.getDateString()}`;
      }
      return `gemini_chat_export_${Utils.getDateString()}`;
    }

    async buildMarkdown(turns, conversationTitle, showProgress = true) {
      const exportDate = new Date().toLocaleString();
      let markdown = conversationTitle
        ? `# ${conversationTitle}\n\n> 📅 Exported on: ${exportDate}\n\n---\n\n`
        : `# Gemini Chat Export\n\n> 📅 Exported on: ${exportDate}\n\n---\n\n`;

      let stats = { processed: 0, fallbackUsed: 0, userMessages: 0, aiMessages: 0 };
      const messages = []; // TOC ve JSON için mesaj listesi

      // Progress toast oluştur
      const progressToast = showProgress ? Utils.createProgressToast('Export başlatılıyor...') : null;

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const progress = Math.round(((i + 1) / turns.length) * 100);

        if (progressToast) {
          progressToast.update(`Mesaj ${i + 1}/${turns.length} işleniyor...`, progress);
        }

        // User message
        const userQueryElem = turn.querySelector(CONFIG.SELECTORS.USER_QUERY);
        if (userQueryElem) {
          const cb = userQueryElem.querySelector(`.${CONFIG.CHECKBOX_CLASS}`);
          if (cb?.checked) {
            const userQuery = userQueryElem.textContent.trim();
            markdown += `## 🧑 You\n\n${userQuery}\n\n`;
            messages.push({ type: 'user', content: userQuery });
            stats.userMessages++;
          }
        }

        // Model response
        const modelRespElem = turn.querySelector(CONFIG.SELECTORS.MODEL_RESPONSE);
        if (modelRespElem) {
          const cb = modelRespElem.querySelector(`.${CONFIG.CHECKBOX_CLASS}`);
          if (cb?.checked) {
            stats.processed++;

            modelRespElem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            await Utils.sleep(CONFIG.TIMING.MOUSEOVER_DELAY);

            let finalText = '';
            let extractionMethod = '';

            // Yöntem 1: DOM-LaTeX extraction (Birincil - data-math attribute'dan)
            try {
              finalText = Utils.extractTextWithLatex(modelRespElem);
              if (finalText && finalText.trim().length > 0) {
                extractionMethod = 'DOM-LaTeX';
              }
            } catch (e) {
              console.warn(`Mesaj ${i + 1}: DOM extraction hatası:`, e);
            }

            // Yöntem 2: Clipboard API (DOM başarısız olursa)
            if (!finalText || finalText.trim().length === 0) {
              const copyBtn = turn.querySelector(CONFIG.SELECTORS.COPY_BUTTON);
              if (copyBtn) {
                finalText = await this.copyModelResponse(turn, copyBtn, i + 1);
                if (finalText && finalText.trim().length > 0) {
                  extractionMethod = 'Clipboard';
                }
              }
            }

            // Yöntem 3: Selection API (Son çare)
            if (!finalText || finalText.trim().length === 0) {
              console.warn(`Mesaj ${i + 1}: Önceki yöntemler başarısız, Selection API kullanılıyor.`);
              finalText = Utils.getTextViaSelection(modelRespElem);
              if (finalText && finalText.trim().length > 0) {
                extractionMethod = 'Selection';
                stats.fallbackUsed++;
              }
            }

            console.log(`Mesaj ${i + 1}: ${extractionMethod} yöntemi kullanıldı (${finalText?.length || 0} karakter)`);

            if (finalText) {
              let processedText = Utils.removeCitations(finalText);
              processedText = Utils.fixBrokenLists(processedText);
              markdown += `## 🤖 Gemini\n\n${processedText}\n\n`;
              messages.push({ type: 'ai', content: processedText });
              stats.aiMessages++;
            } else {
              markdown += `## 🤖 Gemini\n\n[Hata: İçerik alınamadı.]\n\n`;
            }
          }
        }
        markdown += '---\n\n';
      }

      // Progress toast'ı kapat
      if (progressToast) {
        progressToast.close();
      }

      // İstatistik hesapla ve footer ekle
      const contentStats = Utils.calculateStats(markdown);
      markdown += `\n---\n\n`;
      markdown += `## 📊 Export Statistics\n\n`;
      markdown += `| Metric | Value |\n`;
      markdown += `|--------|-------|\n`;
      markdown += `| 📝 Total Words | ${contentStats.words.toLocaleString()} |\n`;
      markdown += `| 🧑 User Messages | ${stats.userMessages} |\n`;
      markdown += `| 🤖 AI Responses | ${stats.aiMessages} |\n`;
      markdown += `| 💻 Code Blocks | ${contentStats.codeBlocks} |\n`;
      markdown += `| 🔢 Math Expressions | ${contentStats.mathExpressions} |\n`;
      markdown += `| 📄 Total Lines | ${contentStats.lines.toLocaleString()} |\n`;
      markdown += `\n> *Exported with [AI Chat Exporter](https://github.com/user/ai-chat-exporter)*\n`;

      return { content: markdown, stats: stats, messages: messages };
    }

    // İçindekiler (TOC) oluştur
    generateTOC(messages, title) {
      let toc = `## 📑 Table of Contents\n\n`;
      messages.forEach((msg, idx) => {
        const icon = msg.type === 'user' ? '🧑' : '🤖';
        const label = msg.type === 'user' ? 'You' : 'Gemini';
        // Preview'dan "Show thinking" ve fazla boşlukları temizle
        const cleanContent = msg.content.replace(/^Show thinking\s*/i, '').trim();
        const preview = cleanContent.substring(0, 50).replace(/\n/g, ' ').trim();
        toc += `${idx + 1}. [${icon} ${label}: ${preview}...](#message-${idx + 1})\n`;
      });
      toc += `\n---\n\n`;
      return toc;
    }

    // Markdown'a TOC ve anchor'lar ekle
    addTOCToMarkdown(markdown, messages, title) {
      const toc = this.generateTOC(messages, title);

      // Başlık ve meta'dan sonraya TOC ekle
      const headerEndIndex = markdown.indexOf('---\n\n') + 5;
      const header = markdown.substring(0, headerEndIndex);
      const content = markdown.substring(headerEndIndex);

      // Mesajlara anchor ekle
      let anchoredContent = content;
      let msgIndex = 0;
      anchoredContent = anchoredContent.replace(/## (🧑|🤖)/g, (match) => {
        msgIndex++;
        return `<a id="message-${msgIndex}"></a>\n\n## ${match.slice(3)}`;
      });

      return header + toc + anchoredContent;
    }

    // Markdown -> JSON dönüştürme
    convertToJSON(markdown, messages, stats, title) {
      return JSON.stringify({
        title: title || 'Gemini Chat Export',
        exportDate: new Date().toISOString(),
        statistics: stats,
        messages: messages.map((msg, idx) => ({
          id: idx + 1,
          type: msg.type,
          content: msg.content
        }))
      }, null, 2);
    }

    // Markdown -> HTML dönüştürme
    convertToHTML(markdown, title) {
      const isDark = Utils.isDarkMode();

      // Basit Markdown -> HTML dönüşümü
      let html = markdown
        // Kod blokları
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
        // Inline kod
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // Başlıklar
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        // Bold
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        // Italic
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        // Strikethrough
        .replace(/~~([^~]+)~~/g, '<del>$1</del>')
        // Links
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        // Images
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%;">')
        // Blockquotes
        .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
        // Horizontal rules
        .replace(/^---$/gm, '<hr>')
        // Line breaks
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');

      // Tablolar için basit dönüşüm
      html = html.replace(/\|(.+)\|\n\|[-|]+\|\n((?:\|.+\|\n?)+)/g, (match, header, rows) => {
        const headers = header.split('|').filter(h => h.trim()).map(h => `<th>${h.trim()}</th>`).join('');
        const bodyRows = rows.trim().split('\n').map(row => {
          const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
          return `<tr>${cells}</tr>`;
        }).join('');
        return `<table><thead><tr>${headers}</tr></thead><tbody>${bodyRows}</tbody></table>`;
      });

      const bgColor = isDark ? '#1a1a2e' : '#f8fafc';
      const textColor = isDark ? '#e2e8f0' : '#1e293b';
      const cardBg = isDark ? '#16213e' : '#ffffff';
      const borderColor = isDark ? '#334155' : '#e2e8f0';
      const accentColor = '#6366f1';

      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title || 'Gemini Chat Export'}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: ${bgColor}; color: ${textColor}; line-height: 1.7; padding: 40px 20px;
    }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { color: ${accentColor}; margin-bottom: 20px; font-size: 2em; }
    h2 { color: ${textColor}; margin: 30px 0 15px; padding-bottom: 10px; border-bottom: 2px solid ${borderColor}; }
    h3 { margin: 20px 0 10px; }
    p { margin: 15px 0; }
    pre { background: ${isDark ? '#0f172a' : '#f1f5f9'}; padding: 16px; border-radius: 8px; overflow-x: auto; margin: 15px 0; }
    code { font-family: 'Fira Code', 'Consolas', monospace; font-size: 0.9em; }
    :not(pre) > code { background: ${isDark ? '#334155' : '#e2e8f0'}; padding: 2px 6px; border-radius: 4px; }
    blockquote { border-left: 4px solid ${accentColor}; padding-left: 16px; margin: 15px 0; color: ${isDark ? '#94a3b8' : '#64748b'}; }
    table { border-collapse: collapse; width: 100%; margin: 15px 0; }
    th, td { border: 1px solid ${borderColor}; padding: 10px; text-align: left; }
    th { background: ${isDark ? '#1e293b' : '#f1f5f9'}; }
    a { color: ${accentColor}; text-decoration: none; }
    a:hover { text-decoration: underline; }
    hr { border: none; border-top: 1px solid ${borderColor}; margin: 30px 0; }
    img { border-radius: 8px; margin: 10px 0; }
    .message { background: ${cardBg}; border-radius: 12px; padding: 20px; margin: 20px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  </style>
</head>
<body>
  <div class="container">
    <p>${html}</p>
  </div>
</body>
</html>`;
    }

    // Markdown -> Plain Text dönüştürme
    convertToTXT(markdown) {
      return markdown
        // Markdown formatlamayı kaldır
        .replace(/^#+\s*/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/```\w*\n/g, '\n')
        .replace(/```/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[Image: $1]')
        .replace(/^>\s*/gm, '  ')
        .replace(/^\|.+\|$/gm, (match) => match.replace(/\|/g, ' | ').trim())
        .replace(/^\|[-|]+\|$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    async exportToClipboard(content) {
      await navigator.clipboard.writeText(content);
    }

    async exportToFile(content, filename, format) {
      const mimeTypes = {
        md: 'text/markdown',
        json: 'application/json',
        html: 'text/html',
        txt: 'text/plain'
      };

      const blob = new Blob([content], { type: mimeTypes[format] || 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename}.${format}`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    }

    async execute(exportMode, customFilename, format = 'md', includeTOC = true) {
      // 1. Önce sayfayı aşağı kaydırıp her şeyi yükle
      await this.scrollToLoadAll();

      // 2. Checkboxları yerleştir
      this.checkboxManager.injectCheckboxes();
      if (!this.checkboxManager.hasAnyChecked()) {
        throw new Error('Lütfen dışa aktarmak için en az bir mesaj seçin.');
      }

      // 3. Başlığı al
      const conversationTitle = this.getConversationTitle();

      // 4. Mesajları topla ve markdown oluştur
      const turns = Array.from(document.querySelectorAll(CONFIG.SELECTORS.CONVERSATION_TURN));
      const result = await this.buildMarkdown(turns, conversationTitle);

      // 5. TOC ekle (sadece md ve html için)
      let finalContent = result.content;
      if (includeTOC && (format === 'md' || format === 'html') && result.messages.length > 0) {
        finalContent = this.addTOCToMarkdown(result.content, result.messages, conversationTitle);
      }

      // 6. Format dönüşümü
      switch (format) {
        case 'json':
          finalContent = this.convertToJSON(result.content, result.messages, result.stats, conversationTitle);
          break;
        case 'html':
          finalContent = this.convertToHTML(finalContent, conversationTitle);
          break;
        case 'txt':
          finalContent = this.convertToTXT(result.content);
          break;
        // md formatı zaten hazır
      }

      // 7. Dışa aktar
      if (exportMode === 'clipboard') {
        await this.exportToClipboard(finalContent);
      } else {
        const filename = this.generateFilename(customFilename, conversationTitle);
        await this.exportToFile(finalContent, filename, format);
      }

      return result.stats;
    }
  }

  // ============================================================================
  // EXPORT CONTROLLER
  // ============================================================================
  class ExportController {
    constructor() {
      this.checkboxManager = new CheckboxManager();
      this.selectionManager = new SelectionManager(this.checkboxManager);
      this.exportService = new ExportService(this.checkboxManager);
      this.button = null;
      this.dropdown = null;
    }

    init() {
      this.createUI();
      this.attachEventListeners();
      this.observeStorageChanges();
    }

    createUI() {
      this.button = UIBuilder.createButton();
      this.dropdown = UIBuilder.createDropdown();
      document.body.appendChild(this.dropdown);
      document.body.appendChild(this.button);
      this.setupFilenameRowToggle();
    }

    setupFilenameRowToggle() {
      const updateFilenameRow = () => {
        const fileRow = this.dropdown.querySelector('#gemini-filename-row');
        const fileRadio = this.dropdown.querySelector(`input[name="${CONFIG.EXPORT_MODE_NAME}"][value="file"]`);
        if (fileRow && fileRadio) {
          fileRow.style.display = fileRadio.checked ? 'block' : 'none';
        }
      };
      this.dropdown.querySelectorAll(`input[name="${CONFIG.EXPORT_MODE_NAME}"]`)
        .forEach(radio => radio.addEventListener('change', updateFilenameRow));
      updateFilenameRow();
    }

    attachEventListeners() {
      this.button.addEventListener('click', () => this.handleButtonClick());

      const selectDropdown = this.dropdown.querySelector(`#${CONFIG.SELECT_DROPDOWN_ID}`);
      selectDropdown.addEventListener('change', (e) => this.handleSelectionChange(e.target.value));

      document.addEventListener('change', (e) => {
        if (e.target?.classList?.contains(CONFIG.CHECKBOX_CLASS)) {
          const select = document.getElementById(CONFIG.SELECT_DROPDOWN_ID);
          if (select && select.value !== 'custom') {
            select.value = 'custom';
            this.selectionManager.lastSelection = 'custom';
          }
        }
      });

      document.addEventListener('mousedown', (e) => {
        if (this.dropdown.style.display !== 'none' &&
          !this.dropdown.contains(e.target) &&
          e.target !== this.button) {
          this.dropdown.style.display = 'none';
        }
      });

      // Klavye kısayolu: Ctrl+Shift+E
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') {
          e.preventDefault();
          Utils.createToast('⌨️ Hızlı export başlatılıyor...', 'info', 1500);
          this.quickExport();
        }
      });
    }

    // Hızlı export (klavye kısayolu için)
    async quickExport() {
      try {
        this.button.disabled = true;
        this.button.textContent = 'İşleniyor...';

        // Varsayılan ayarlarla export
        await this.exportService.execute('file', '');

        this.checkboxManager.removeAll();
        this.selectionManager.reset();

        Utils.createToast('✅ Export tamamlandı!', 'success', 3000);
      } catch (error) {
        console.error('Quick export hatası:', error);
        Utils.createToast(`❌ Hata: ${error.message}`, 'error', 4000);
      } finally {
        this.button.disabled = false;
        this.button.textContent = 'Export Chat';
      }
    }

    handleSelectionChange(value) {
      this.checkboxManager.injectCheckboxes();
      this.selectionManager.applySelection(value);
    }

    async handleButtonClick() {
      this.checkboxManager.injectCheckboxes();

      if (this.dropdown.style.display === 'none') {
        this.dropdown.style.display = '';
        return;
      }

      this.button.disabled = true;
      this.button.textContent = 'İşleniyor...';

      try {
        const exportMode = this.dropdown.querySelector(`input[name="${CONFIG.EXPORT_MODE_NAME}"]:checked`)?.value || 'file';
        const customFilename = exportMode === 'file'
          ? this.dropdown.querySelector(`#${CONFIG.FILENAME_INPUT_ID}`)?.value.trim() || ''
          : '';

        // Format ve TOC seçeneklerini al
        const format = this.dropdown.querySelector(`#${CONFIG.FORMAT_DROPDOWN_ID}`)?.value || 'md';
        const includeTOC = this.dropdown.querySelector(`#${CONFIG.TOC_CHECKBOX_ID}`)?.checked ?? true;

        this.dropdown.style.display = 'none';

        // Execute işlemini çağır ve sonucu al
        const stats = await this.exportService.execute(exportMode, customFilename, format, includeTOC);

        // Temizlik işlemleri
        this.checkboxManager.removeAll();
        this.selectionManager.reset();

        if (exportMode === 'file') {
          const filenameInput = this.dropdown.querySelector(`#${CONFIG.FILENAME_INPUT_ID}`);
          if (filenameInput) filenameInput.value = '';
        }

        // Sonuç Bildirimi - Toast kullan
        const formatNames = { md: 'Markdown', json: 'JSON', html: 'HTML', txt: 'Text' };
        const modeText = exportMode === 'clipboard' ? 'panoya kopyalandı' : `${formatNames[format]} olarak kaydedildi`;
        Utils.createToast(`✅ ${stats.processed} mesaj ${modeText}!`, 'success', 4000);

        if (stats.fallbackUsed > 0) {
          setTimeout(() => {
            Utils.createToast(`⚠️ ${stats.fallbackUsed} mesajda yedek yöntem kullanıldı`, 'warning', 4000);
          }, 1000);
        }

      } catch (error) {
        console.error('Export hatası:', error);
        Utils.createToast(`❌ Hata: ${error.message}`, 'error', 5000);
      } finally {
        this.button.disabled = false;
        this.button.textContent = 'Export Chat';
      }
    }

    observeStorageChanges() {
      // (Aynı kalacak, değişikliğe gerek yok)
      const updateVisibility = () => {
        try {
          if (chrome?.storage?.sync) {
            chrome.storage.sync.get(['hideExportBtn'], (result) => {
              this.button.style.display = result.hideExportBtn ? 'none' : '';
            });
          }
        } catch (e) { }
      };
      updateVisibility();
      const observer = new MutationObserver(updateVisibility);
      observer.observe(document.body, { childList: true, subtree: true });
      if (chrome?.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'sync' && 'hideExportBtn' in changes) updateVisibility();
        });
      }
    }
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  const controller = new ExportController();
  controller.init();

})();