import React, { useState, RefObject } from 'react';
import type { ElementRef } from '../../app/src/types';

export function useAutocomplete(
  elements: ElementRef[], 
  value: string, 
  setValue: (v: string) => void, 
  ref: RefObject<HTMLTextAreaElement | HTMLInputElement>
) {
  const [show, setShow] = useState(false);
  const [query, setQuery] = useState('');
  const [cursorPos, setCursorPos] = useState(0);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    const text = e.target.value;
    setValue(text);
    
    // We need to delay getting selectionStart on some browsers or just read it directly
    const cursor = e.target.selectionStart || 0;
    setCursorPos(cursor);
    
    const beforeCursor = text.slice(0, cursor);
    // match '@' followed by any word chars, hyphens, and spaces up to cursor
    // The query can be empty (just '@') or partially typed
    const match = beforeCursor.match(/@([\w-\s]*)$/);
    if (match) {
      setShow(true);
      setQuery(match[1]);
    } else {
      setShow(false);
    }
  };

  const insertElement = (element: ElementRef) => {
    const beforeCursor = value.slice(0, cursorPos);
    const match = beforeCursor.match(/@([\w-\s]*)$/);
    if (match) {
      const afterCursor = value.slice(cursorPos);
      const newBefore = beforeCursor.slice(0, match.index) + `<<<${element.id}>>> `;
      setValue(newBefore + afterCursor);
      setShow(false);
      
      setTimeout(() => {
        if (ref.current) {
           ref.current.focus();
           const pos = newBefore.length;
           ref.current.setSelectionRange(pos, pos);
        }
      }, 0);
    }
  };

  const filtered = elements.filter(el => el.name.toLowerCase().includes(query.toLowerCase().trim()));

  const AutocompletePopover = () => {
    if (!show || filtered.length === 0) return null;
    return (
      <div className="autocomplete-popover">
        {filtered.map(el => (
          <div key={el.id} className="ac-item" onClick={() => insertElement(el)}>
            <div className="thumb">
              {el.imagePath ? (
                <img src={`/api/project/test_project/media/images/${el.imagePath.split('/').pop()}`} alt={el.name} />
              ) : null}
            </div>
            <span>@{el.name}</span>
          </div>
        ))}
      </div>
    );
  };

  return { onChange, AutocompletePopover };
}
