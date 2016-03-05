# babel-plugin-vdux-transform

Forked from the excellent [babel-plugin-react-transform](https://github.com/gaearon/babel-plugin-react-transform). Does the same thing but works with components that aren't passed to any sort of constructor (e.g. `React.createClass`) so that it can be used with vdux and other things like [deku](https://github.com/dekujs/deku).

## Usage

This plugin doesn't do anything on its own, it just enables you to write transforms for your components. You apply those transforms like this:

```javascript
{
  plugins: [
    ["vdux-transform", {
      "transforms": [{
        // can be an NPM module name or a local path
        "transform": "vdux-transform-hmr"
      }, {
        // can be an NPM module name or a local path
        "transform": "./src/my-custom-transform"
      }]
    }]
  ]
}
```

## Writing transforms

A trivial transform to add displayName's to components looks like this:

```javascript
function transform (opts) {
  return (component) => {
    const parts = opts.filename.split('/')
    const file = parts[parts.length - 1]
    const name = file.slice(0, file.indexOf('.'))
    const displayName = name[0].toUpperCase() + name.slice(1)

    return {
      displayName,
      ...component,
    }
  }
}
```
