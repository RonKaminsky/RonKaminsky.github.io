/* global WebAssembly */
/* global wasmPlugin */

// (easily) customizable parameters
var internalEncoding = 'utf-8'; // 'utf-16' is also supported (but not well-checked)
var lineBreakLength = 70;

function announceError (message) {
  throw new Error(message);
}

function base64ToBuffer (theString) {
  var cleanInput = String(theString).replace(/[\t\n\f\r ]+/g, '');
  var binaryString = window.atob(cleanInput);
  var bufferLength = binaryString.length;
  var buffer = new ArrayBuffer(bufferLength);
  var bytes = new Uint8Array(buffer);
  for (var i = 0; i < bufferLength; ++i) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return buffer;
}

function hexToBuffer (theString) {
  var cleanInput = String(theString).replace(/[\t\n\f\r ]+/g, '');
  if ((cleanInput.length % 2) === 1) {
    announceError('Hex input must have an even number of digits');
  }
  var hexes = cleanInput.match(/../g) || [];
  var bufferLength = cleanInput.length / 2;
  var buffer = new ArrayBuffer(bufferLength);
  var bytes = new Uint8Array(buffer);
  for (var i = 0; i < bufferLength; ++i) {
    bytes[i] = parseInt(hexes[i], 16);
  }
  return buffer;
}

function toBuffer (theString) {
  if (internalEncoding === 'utf-8') {
    return toUtf8Buffer(theString);
  } else if (internalEncoding === 'utf-16') {
    return toUtf16Buffer(theString);
  } else {
    announceError('Unsupported encoding');
  }
}

function toUtf8Buffer (theString) {
  // temporarily use {un,}escape(...) until Text{En,De}code support is OK
  var binaryString = unescape(encodeURIComponent(theString));
  var bufferLength = binaryString.length;
  var buffer = new ArrayBuffer(bufferLength);
  var bytes = new Uint8Array(buffer);
  for (var i = 0; i < bufferLength; ++i) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return buffer;
}

function toUtf16Buffer (theString) {
  var bufferLength = this.length * 2;
  var buffer = new ArrayBuffer(bufferLength);
  var bytes = new Uint8Array(buffer);
  for (var i = 0; i < bufferLength; ++i) {
    bytes[2 * i] = this.charCodeAt(i) % 256;
    bytes[2 * i + 1] = this.charCodeAt(i) >>> 8;
  }
  return buffer;
}

function rawStringFromBufferArray (bufferArray) {
  return String.fromCharCode.apply(null, bufferArray);
}

function hexFromBuffer (buffer) {
  var bytes = new Uint8Array(buffer);
  return Array.from(bytes).map(x => ('00' + x.toString(16)).slice(-2)).join('');
}

function base64FromBuffer (buffer) {
  var binaryString = rawStringFromBufferArray(new Uint8Array(buffer));
  return window.btoa(binaryString);
}

function fromBuffer (buffer) {
  if (internalEncoding === 'utf-8') {
    return fromUtf8Buffer(buffer);
  } else if (internalEncoding === 'utf-16') {
    return fromUtf16Buffer(buffer);
  } else {
    announceError('Unsupported encoding');
  }
}

function fromUtf8Buffer (buffer) {
  var byteArray = new Uint8Array(buffer);
  // temporarily use {un,}escape(...) until Text{En,De}code support is OK
  var binaryString = rawStringFromBufferArray(byteArray);
  return decodeURIComponent(escape(binaryString));
}

function fromUtf16Buffer (buffer) {
  if (buffer.length % 2 === 1) {
    announceError('UTF-16 encoded string must have an even number of bytes');
  }
  var bufferLength = buffer.length / 2;
  var utf16Buffer = new Uint16Array(bufferLength);
  for (var i = 0; i < bufferLength; ++i) {
    utf16Buffer[i] = buffer[2 * i] + (buffer[2 * i + 1] << 8);
  }
  return rawStringFromBufferArray(utf16Buffer);
}

function brokenIntoLines (theString, length) {
  var cleanInput = String(theString).replace(/[\t\n\f\r ]+/gm, '');
  var breakDefinition = '(.{' + String(length) + '})';
  var breakRegex = new RegExp(breakDefinition, 'g');
  return String(cleanInput).replace(breakRegex, '$&\n');
}

// create Array of plugin instances from base 64 encodings

// following might use Object.entries(), Object.fromEntries() and map() when support is better?
// (or maybe I should learn how to use JS objects properly?)

var wasmInstances = {};
var wasmMemory = {};

for (var key in wasmPlugin) {
  if ({}.hasOwnProperty.call(wasmPlugin, key)) {
    var wasmBase64 = wasmPlugin[key];
    wasmMemory[key] = new WebAssembly.Memory({ initial: 75 });
    try {
      wasmInstances[key] = WebAssembly.instantiate(base64ToBuffer(wasmBase64),
        { env: { memory: wasmMemory[key] } });
    } catch (e) {
      window.alert(e);
      throw e;
    }
  }
}

function promiseFailureCallback (error) {
  console.error('Error in promise: ' + error);
  window.alert('Error in promise: ' + error);
}

function inputAsBuffer () {
  if (document.obpg_form.inputformat[0].checked) {
    return base64ToBuffer(document.obpg_form.the_data.value);
  } else if (document.obpg_form.inputformat[1].checked) {
    return hexToBuffer(document.obpg_form.the_data.value);
  } else {
    return toBuffer(document.obpg_form.the_data.value);
  }
}

const bytesPerWasmPage = 64 * 1024;
var outputSlice = null;

function selectedPlugin () {
  var selector = document.getElementById('action');
  var pluginName = selector.options[selector.selectedIndex].value;
  return wasmInstances[pluginName];
}

function selectedMemory () {
  var selector = document.getElementById('action');
  var pluginName = selector.options[selector.selectedIndex].value;
  return wasmMemory[pluginName];
}

function runDirection (runForward) {
  document.obpg_form.the_output.value = '';
  try {
    var data = new Uint8Array(inputAsBuffer());
  } catch (e) {
    window.alert(e);
    console.error(e);
  }

  selectedPlugin().then(result => {
    var outputLength = (runForward
      ? result.instance.exports.requiredForwardOutputLengthInBytes(data.length)
      : result.instance.exports.requiredBackwardOutputLengthInBytes(data.length));
    var base = result.instance.exports.__heap_base;
    var memoryView = new Uint8Array(selectedMemory().buffer);
    var availableMemory = memoryView.length - base;
    if (availableMemory < (data.length + outputLength)) {
      // need to enlarge memory
      var additionalPages = ((data.length + outputLength - availableMemory) + bytesPerWasmPage - 1) / bytesPerWasmPage;
      selectedMemory().grow(additionalPages);
      memoryView = new Uint8Array(selectedMemory().buffer);
    }
    for (var i = 0; i < data.length; ++i) {
      memoryView[base + i] = data[i];
    }
    try {
      var realOutputLengthInBytes = (runForward
        ? result.instance.exports.forward(base, data.length, base + data.length)
        : result.instance.exports.backward(base, data.length, base + data.length));
      outputSlice = memoryView.slice(base + data.length, base + data.length + realOutputLengthInBytes);
      redisplayOutput();
    } catch (e) {
      window.alert(e);
      console.error(e);
    }
  }, promiseFailureCallback);
}

// the following functions are called from HTML on events

function forward () { // eslint-disable-line no-unused-vars
  runDirection(true);
}

function backward () { // eslint-disable-line no-unused-vars
  runDirection(false);
}

function doSwitch () { // eslint-disable-line no-unused-vars
  var temp = document.obpg_form.the_data.value;
  document.obpg_form.the_data.value = document.obpg_form.the_output.value;
  document.obpg_form.the_output.value = temp;
}

function doClear () { // eslint-disable-line no-unused-vars
  document.obpg_form.the_data.value = '';
  outputSlice = null;
  redisplayOutput();
}

function doBreakLines () { // eslint-disable-line no-unused-vars
  var output = document.obpg_form.the_output;
  output.value = brokenIntoLines(output.value, lineBreakLength);
  output.select();
}

function setParameter () { // eslint-disable-line no-unused-vars
  if (selectedPlugin() !== undefined) {
    var index = parseInt(window.prompt('Enter parameter index'));
    var value = parseInt(window.prompt('Enter parameter value'));

    try {
      selectedPlugin().then(result => {
        result.instance.exports.setParameter(index & 0xFFFFFFFF, value & 0xFFFFFFFF);
      }, promiseFailureCallback);
    } catch (e) {
      window.alert(e);
      console.error(e);
    }
  }
}

function redisplayOutput () {
  var output = document.obpg_form.the_output;
  output.style.backgroundColor = "white";
  if (outputSlice === null) {
    output.value = '';
  } else if (document.obpg_form.outputformat[0].checked) {
    output.value = base64FromBuffer(outputSlice);
    output.select();
  } else if (document.obpg_form.outputformat[1].checked) {
    output.value = hexFromBuffer(outputSlice);
    output.select();
  } else {
    try {
      output.value = fromBuffer(outputSlice);
      output.select();
    } catch (e) {
      output.value = '';
      console.error(e);
      if (e == "URIError: malformed URI sequence") {
        output.style.backgroundColor = "#FF4040";
      } else {
        window.alert(e);
      }
    }
  }
}

// get rid of textarea default garbage due to nicely formatting HTML
doClear();
