//! Command implementations for debug server

mod input;
mod navigation;
mod screenshot;
mod script;
mod snapshot;

/// JavaScript code to build accessibility tree snapshot
/// Note: This code is wrapped by eval_with_result, so it should end with a return statement
pub const SNAPSHOT_JS: &str = r#"
    let refCounter = 0;
    const refMap = new Map();

    // Store ref map globally for later use (click by ref, etc.)
    window.__MCP_REF_MAP__ = refMap;

    function getRole(el) {
        // Explicit ARIA role
        if (el.getAttribute('role')) return el.getAttribute('role');

        // Implicit roles based on tag
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type');

        const roleMap = {
            'a': el.href ? 'link' : null,
            'button': 'button',
            'input': {
                'text': 'textbox',
                'email': 'textbox',
                'password': 'textbox',
                'search': 'searchbox',
                'tel': 'textbox',
                'url': 'textbox',
                'number': 'spinbutton',
                'checkbox': 'checkbox',
                'radio': 'radio',
                'submit': 'button',
                'button': 'button',
                'reset': 'button',
                'range': 'slider',
            },
            'select': 'combobox',
            'textarea': 'textbox',
            'img': 'img',
            'h1': 'heading',
            'h2': 'heading',
            'h3': 'heading',
            'h4': 'heading',
            'h5': 'heading',
            'h6': 'heading',
            'ul': 'list',
            'ol': 'list',
            'li': 'listitem',
            'table': 'table',
            'tr': 'row',
            'td': 'cell',
            'th': 'columnheader',
            'nav': 'navigation',
            'main': 'main',
            'header': 'banner',
            'footer': 'contentinfo',
            'aside': 'complementary',
            'form': 'form',
            'dialog': 'dialog',
            'article': 'article',
            'section': 'region',
        };

        if (tag === 'input') {
            return roleMap['input'][type] || 'textbox';
        }
        return roleMap[tag] || null;
    }

    function getAccessibleName(el) {
        // aria-label
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');

        // aria-labelledby
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl) return labelEl.textContent.trim();
        }

        // label for input
        if (el.id) {
            const label = document.querySelector(`label[for="${el.id}"]`);
            if (label) return label.textContent.trim();
        }

        // placeholder
        if (el.placeholder) return el.placeholder;

        // alt for images
        if (el.alt) return el.alt;

        // title
        if (el.title) return el.title;

        // Direct text content for certain elements
        const tag = el.tagName.toLowerCase();
        if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'li'].includes(tag)) {
            const text = el.textContent.trim();
            if (text && text.length < 100) return text;
        }

        return null;
    }

    function isVisible(el) {
        if (!el.offsetParent && el.tagName.toLowerCase() !== 'body') return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
    }

    function isInteractive(el) {
        const tag = el.tagName.toLowerCase();
        const interactiveTags = ['a', 'button', 'input', 'select', 'textarea'];
        if (interactiveTags.includes(tag)) return true;
        if (el.getAttribute('role') === 'button') return true;
        if (el.onclick || el.getAttribute('onclick')) return true;
        if (el.tabIndex >= 0) return true;
        return false;
    }

    function buildTree(el, depth = 0) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
        if (!isVisible(el)) return null;

        const role = getRole(el);
        const name = getAccessibleName(el);
        const isInter = isInteractive(el);

        // Skip non-semantic elements unless they have children worth showing
        const skipTags = ['div', 'span', 'script', 'style', 'noscript', 'svg', 'path'];
        const tag = el.tagName.toLowerCase();

        let children = [];
        for (const child of el.children) {
            const childNode = buildTree(child, depth + 1);
            if (childNode) children.push(childNode);
        }

        // Skip non-semantic containers with single child (flatten)
        if (skipTags.includes(tag) && !role && !isInter && children.length === 1) {
            return children[0];
        }

        // Skip empty non-semantic elements
        if (skipTags.includes(tag) && !role && !isInter && children.length === 0 && !name) {
            return null;
        }

        const ref = ++refCounter;
        refMap.set(ref, el);

        const node = { ref };
        if (role) node.role = role;
        else node.tag = tag;
        if (name) node.name = name;
        if (isInter) node.interactive = true;

        // Add value for form elements
        if (el.value !== undefined && el.value !== '') {
            node.value = el.value;
        }

        // Add checked state
        if (el.checked !== undefined) {
            node.checked = el.checked;
        }

        // Add disabled state
        if (el.disabled) {
            node.disabled = true;
        }

        if (children.length > 0) {
            node.children = children;
        }

        return node;
    }

    function treeToText(node, indent = 0) {
        if (!node) return '';

        const prefix = '  '.repeat(indent);
        let line = prefix + `- [ref=${node.ref}]`;

        if (node.role) line += ` ${node.role}`;
        else if (node.tag) line += ` <${node.tag}>`;

        if (node.name) line += ` "${node.name}"`;
        if (node.value) line += ` value="${node.value}"`;
        if (node.checked) line += ` [checked]`;
        if (node.disabled) line += ` [disabled]`;

        let result = line + '\n';

        if (node.children) {
            for (const child of node.children) {
                result += treeToText(child, indent + 1);
            }
        }

        return result;
    }

    const tree = buildTree(document.body);
    const snapshot = treeToText(tree);

    return {
        url: window.location.href,
        title: document.title,
        snapshot: snapshot
    };
"#;

/// JavaScript code to click an element by CSS selector
pub fn click_js(selector: &str) -> String {
    format!(
        r#"
const el = document.querySelector({selector});
if (!el) {{
    return {{ success: false, error: 'Element not found: {raw_selector}' }};
}}
el.click();
return {{ success: true }};
"#,
        selector = serde_json::to_string(selector).unwrap(),
        raw_selector = selector
    )
}

/// JavaScript code to click an element by ref number
pub fn click_ref_js(ref_num: u32) -> String {
    format!(
        r#"
const refMap = window.__MCP_REF_MAP__;
if (!refMap) {{
    return {{ success: false, error: 'No snapshot taken yet. Call snapshot first.' }};
}}
const el = refMap.get({ref_num});
if (!el) {{
    return {{ success: false, error: 'Element ref={ref_num} not found. Snapshot may be stale.' }};
}}
el.scrollIntoView({{ behavior: 'instant', block: 'center' }});
el.click();
return {{ success: true }};
"#,
        ref_num = ref_num
    )
}

/// JavaScript code to fill an input by CSS selector
pub fn fill_js(selector: &str, value: &str) -> String {
    format!(
        r#"
const el = document.querySelector({selector});
if (!el) {{
    return {{ success: false, error: 'Element not found: {raw_selector}' }};
}}
el.value = {value};
el.dispatchEvent(new Event('input', {{ bubbles: true }}));
el.dispatchEvent(new Event('change', {{ bubbles: true }}));
return {{ success: true }};
"#,
        selector = serde_json::to_string(selector).unwrap(),
        raw_selector = selector,
        value = serde_json::to_string(value).unwrap()
    )
}

/// JavaScript code to fill an input by ref number
pub fn fill_ref_js(ref_num: u32, value: &str) -> String {
    format!(
        r#"
const refMap = window.__MCP_REF_MAP__;
if (!refMap) {{
    return {{ success: false, error: 'No snapshot taken yet. Call snapshot first.' }};
}}
const el = refMap.get({ref_num});
if (!el) {{
    return {{ success: false, error: 'Element ref={ref_num} not found. Snapshot may be stale.' }};
}}
el.scrollIntoView({{ behavior: 'instant', block: 'center' }});
el.focus();
el.value = {value};
el.dispatchEvent(new Event('input', {{ bubbles: true }}));
el.dispatchEvent(new Event('change', {{ bubbles: true }}));
return {{ success: true }};
"#,
        ref_num = ref_num,
        value = serde_json::to_string(value).unwrap()
    )
}

/// JavaScript code to press a key
pub fn press_key_js(key: &str) -> String {
    format!(
        r#"
const activeEl = document.activeElement || document.body;
const keyEvent = new KeyboardEvent('keydown', {{
    key: {key},
    bubbles: true,
    cancelable: true
}});
activeEl.dispatchEvent(keyEvent);

const keyUpEvent = new KeyboardEvent('keyup', {{
    key: {key},
    bubbles: true,
    cancelable: true
}});
activeEl.dispatchEvent(keyUpEvent);

return {{ success: true }};
"#,
        key = serde_json::to_string(key).unwrap()
    )
}

/// JavaScript code to navigate
pub fn navigate_js(url: &str) -> String {
    format!(
        r#"
window.location.href = {url};
return {{ success: true }};
"#,
        url = serde_json::to_string(url).unwrap()
    )
}

/// JavaScript code to take a screenshot
pub const SCREENSHOT_JS: &str = r#"
    // Load html2canvas if not already loaded
    if (!window.html2canvas) {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        document.head.appendChild(script);
        await new Promise(resolve => script.onload = resolve);
    }

    // Helper to convert modern CSS colors (oklch, oklab, lab, lch) to RGB
    // html2canvas doesn't support these color functions
    function convertModernColors(clonedDoc, originalDoc) {
        const modernColorRegex = /oklch\([^)]+\)|oklab\([^)]+\)|lab\([^)]+\)|lch\([^)]+\)/gi;

        // Get all elements from both documents in same order
        const clonedElements = clonedDoc.querySelectorAll('*');
        const originalElements = originalDoc.querySelectorAll('*');

        // List of color properties to check
        const colorProps = [
            'color', 'backgroundColor', 'borderColor',
            'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
            'outlineColor', 'textDecorationColor', 'caretColor', 'fill', 'stroke'
        ];

        clonedElements.forEach((el, index) => {
            const originalEl = originalElements[index];
            if (!originalEl) return;

            const computed = window.getComputedStyle(originalEl);

            colorProps.forEach(prop => {
                try {
                    const value = computed[prop];
                    if (value && modernColorRegex.test(value)) {
                        // Browser auto-converts oklch to rgb in getComputedStyle
                        // But if it's still oklch, use a fallback
                        el.style.setProperty(prop.replace(/([A-Z])/g, '-$1').toLowerCase(), 'inherit', 'important');
                    }
                } catch (e) {
                    // Ignore errors
                }
            });
        });

        // Process stylesheets - replace modern colors with transparent
        const styleSheets = clonedDoc.querySelectorAll('style');
        styleSheets.forEach(styleEl => {
            if (styleEl.textContent && modernColorRegex.test(styleEl.textContent)) {
                styleEl.textContent = styleEl.textContent.replace(modernColorRegex, 'transparent');
            }
        });
    }

    try {
        const canvas = await window.html2canvas(document.body, {
            useCORS: true,
            allowTaint: true,
            scale: 0.5,
            logging: false,  // Suppress logging
            onclone: (clonedDoc) => {
                convertModernColors(clonedDoc, document);
            }
        });

        // Resize to max 1280x720 to limit output size
        const maxWidth = 1280;
        const maxHeight = 720;
        let width = canvas.width;
        let height = canvas.height;

        if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = Math.floor(width * ratio);
            height = Math.floor(height * ratio);
        }

        const resized = document.createElement('canvas');
        resized.width = width;
        resized.height = height;
        resized.getContext('2d').drawImage(canvas, 0, 0, width, height);

        // JPEG with 0.6 quality for smaller file size
        const dataUrl = resized.toDataURL('image/jpeg', 0.6);
        return {
            data: dataUrl,
            width: width,
            height: height
        };
    } catch (e) {
        // If html2canvas fails, try a simpler approach using canvas
        // This is a fallback that captures a blank/simple version
        throw new Error('Screenshot failed: ' + e.message);
    }
"#;
