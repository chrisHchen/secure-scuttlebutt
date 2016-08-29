var pull = require('pull-stream')
var Level = require('level')
var bytewise = require('bytewise')
var Write = require('pull-write')
var pl = require('pull-level')
var defer = require('pull-defer')

function create(path) {
  return Level(path, {keyEncoding: bytewise, valueEncoding: 'json'})
}

module.exports = function (_db, path, version, map) {
  var db = create(path)

  var META = '\x00', since

  db.get(META, function (err, value) {
    since = value && value.since || 0
    if(err) // new database
      next()
    else if (value.version !== version) {
      db.close(function () {
        level.destroy(path, function (err) {
          if(err) throw err //just die?
          db = create(path)
          since = 0
          next()
        })
      })
    }
  })

  var written = 0, waiting = []

  function await(ready) {
    if(_db.seen === written) return ready()
    waiting.push({ts: _db.seen, cb: ready})
  }

  function next () {
    pull(
      _db.createLogStream({gt: since, live: true, sync: false}),
      Write(function (batch, cb) {
        db.batch(batch, function (err) {
          if(err) return cb(err)
          written = batch[0].value.since
          //callback to anyone waiting for this point.
          while(waiting.length && waiting[0].ts <= written)
            waiting.shift().cb()

          cb()
        })
      }, function reduce (batch, data) {
        if(data.sync) return batch
        var ts = data.ts || data.timestamp

        if(!batch)
          batch = [{
            key: META,
            value: {version: version, since: ts},
            valueEncoding: 'json', keyEncoding:'utf8', type: 'put'
          }]

        batch = batch.concat(map(data))
        batch[0].value.since = Math.max(batch[0].value.since, ts)
        console.log(batch)
        return batch
      })
    )
  }

  return {
    get: function (key, cb) {
      //wait until the log has been processed up to the current point.
      await(function () {
        db.get(key, cb)
      })
    },
    read: function (opts) {
      if(written === _db.seen) return pl.read(db, opts)

      var source = defer.source()
      await(function () {
        source.resolve(pl.read(db, opts))
      })
      return source
    }
    //put, del, batch - leave these out for now, since the indexes just map.
  }
}









